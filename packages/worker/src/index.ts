import { isRunnerJob, type RunnerJob } from '@vozka/runner'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { handleApi } from './api/router'
import { Db } from './db'
import type { Env } from './env'
import { createIam } from './iam'
import { type ContainerLike, type RelayResult, relayRun } from './relay'
import { GitHubAppRepoSource, type RepoSource } from './repo-source'
import { type DeployJobMessage, executeDeploy, type RunDeps, type RunOutcome } from './run-lifecycle'
import { VaultSecretResolver } from './secret-resolver'
import { Vault } from './vault'
import { handleWebhook } from './webhook'

export { DeployLock } from './DeployLock'
export { RunnerContainer } from './RunnerContainer'

/**
 * How long a deploy may hold its per-app-env lock before it's treated as stale and auto-released. A
 * deploy (clone + install + wrangler + reconcile) finishes well inside this; the runner container is
 * hard-killed ~15 min anyway. The lease self-heals after this if a consumer dies without releasing.
 */
const DEPLOY_LOCK_TTL_MS = 30 * 60 * 1000
/** Delay before a deferred run (another deploy of the same app-env in flight) is re-checked. */
const DEPLOY_LOCK_REQUEUE_DELAY_S = 30

/**
 * The vozka control-plane Worker — a single `WorkerEntrypoint` carrying:
 *   - `startRun` (M2): boot a per-run container, relay its logs + terminal status into R2.
 *   - `fetch`: health, the HMAC-gated GitHub webhook, the ACL-gated `/api/*` control surface, and the
 *     dashboard SPA (assets) for everything else.
 *   - `queue`: the deploy consumer — dequeue a run, assemble its job, run it, record the outcome.
 *
 * The registry/run schema lives in D1 (migrations/0001_init.sql); authorization + audit go through
 * propustka (src/iam.ts). Credentials + secret values are resolved through the SecretResolver seam
 * (src/secret-resolver.ts) — the encrypted vault is M4. The dashboard UI itself is M3b.
 */
export class Vozka extends WorkerEntrypoint<Env> {
	/**
	 * Start one deploy run: address a fresh container instance for this `runId`, wait for its server
	 * to come up, then relay the job through it (logs + status → R2). Returns the terminal status.
	 * RPC-callable (service binding) and the engine the queue consumer drives.
	 */
	async startRun(job: RunnerJob): Promise<RelayResult> {
		const id = this.env.RUNNER.idFromName(job.runId)
		const container = this.env.RUNNER.get(id)
		await container.startAndWaitForPorts()
		const relayable: ContainerLike = {
			containerFetch: (input, init) => container.containerFetch(input, init),
			heartbeat: () => container.heartbeat(),
		}
		return relayRun(relayable, this.env.RUN_LOGS, job)
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/api/health') {
			return Response.json({ status: 'ok', service: 'vozka', milestone: 'M4' })
		}

		// The ONE unauthenticated route: the GitHub webhook (HMAC-gated, not Access-gated).
		if (request.method === 'POST' && url.pathname === '/webhooks/github') {
			return handleWebhook(request, {
				db: new Db(this.env.DB),
				repoSource: this.repoSource(),
				queue: this.env.DEPLOY_QUEUE,
			})
		}

		// M2 compatibility: the raw `POST /api/runs` relay entry (a RunnerJob straight to startRun).
		// Kept so the M2 path still works; the M3a control surface is everything else under /api/.
		if (request.method === 'POST' && url.pathname === '/api/runs') {
			let job: unknown
			try {
				job = await request.json()
			} catch {
				return Response.json({ error: 'invalid JSON body' }, { status: 400 })
			}
			if (!isRunnerJob(job)) {
				return Response.json({ error: 'body is not a valid RunnerJob' }, { status: 400 })
			}
			const result = await this.startRun(job)
			return Response.json(result)
		}

		// The ACL-gated control surface (registry / runs / triggers / vault).
		if (url.pathname.startsWith('/api/')) {
			return handleApi(request, {
				db: new Db(this.env.DB),
				iam: createIam(this.env),
				queue: this.env.DEPLOY_QUEUE,
				logs: this.env.RUN_LOGS,
				vault: () => this.vault(),
			})
		}

		// Everything else: the dashboard SPA (M3b), served from the assets binding.
		return this.env.ASSETS.fetch(request)
	}

	/**
	 * The deploy consumer. One run per message (maxBatchSize 1): load it from D1, transition it
	 * pending → running, assemble its `RunnerJob`, run it via `startRun`, and record the terminal
	 * outcome into D1. The lifecycle is idempotent (status-guarded), so a redelivered message is a
	 * safe no-op. ack on a handled run; retry only on an unexpected throw (Cloudflare redelivers).
	 */
	override async queue(batch: MessageBatch<DeployJobMessage>): Promise<void> {
		const deps = await this.runDeps()
		for (const message of batch.messages) {
			try {
				const result = await executeDeploy(deps, message.body)
				if (result.status === 'deferred') {
					// Another deploy of this app-env is in flight. Re-enqueue as a FRESH delivery (so the
					// retry budget stays reserved for genuine errors) with a short delay; the run stays
					// pending and runs once the lock frees. Then ack this message.
					await this.env.DEPLOY_QUEUE.send(message.body, { delaySeconds: DEPLOY_LOCK_REQUEUE_DELAY_S })
				}
				message.ack()
			} catch (err) {
				// executeDeploy already records assembly/relay failures as a `failed` run and does not
				// throw; reaching here means an unexpected error before/around it. Retry (bounded by
				// the queue's maxRetries) rather than dropping the message.
				console.error('deploy consumer error', err instanceof Error ? err.message : 'unknown error')
				message.retry()
			}
		}
	}

	/** Assemble the run-lifecycle deps from the Worker bindings (startRun adapted to RunOutcome). */
	private async runDeps(): Promise<RunDeps> {
		const startRun = async (job: RunnerJob): Promise<RunOutcome> => {
			const result = await this.startRun(job)
			// The relay only resolves on a terminal status; narrow its state to the lifecycle's union.
			const state = result.status.state === 'succeeded' ? 'succeeded' : 'failed'
			return { status: { state, ...(result.status.exitCode !== undefined ? { exitCode: result.status.exitCode } : {}) } }
		}
		// The vault-backed resolver dispatches by ref scheme: `vault:<id>` → the encrypted D1 vault,
		// `secretstore:<name>` → CF Secrets Store (CF-only), `env:`/`literal:` → dev bindings. The vault
		// is built only when VOZKA_VAULT_KEY is present (so the env/literal path still works without it);
		// a `vault:` ref with no vault configured fails the run loudly rather than deploying empty creds.
		return {
			db: new Db(this.env.DB),
			repoSource: this.repoSource(),
			secrets: new VaultSecretResolver({
				...(this.env.VOZKA_VAULT_KEY !== undefined ? { vault: await this.vault() } : {}),
				env: {
					GITHUB_WEBHOOK_SECRET: this.env.GITHUB_WEBHOOK_SECRET,
					GITHUB_APP_ID: this.env.GITHUB_APP_ID,
				},
			}),
			startRun,
			// Per-app-env mutual exclusion, backed by the DeployLock DO (one instance per `<app>:<env>`).
			lock: {
				acquire: (key, holder) => this.env.DEPLOY_LOCK.get(this.env.DEPLOY_LOCK.idFromName(key)).acquire(holder, DEPLOY_LOCK_TTL_MS),
				release: (key, holder) => this.env.DEPLOY_LOCK.get(this.env.DEPLOY_LOCK.idFromName(key)).release(holder),
			},
			// vozka's build-time platform deploy config: the single CF account/token + propustka coords,
			// injected into every job (single-account — no per-account registry). Empty creds fail the run
			// loudly in assembleJob rather than deploying empty. Optional propustka coords are omitted when
			// unset (an app without access/schema never needs them).
			deploy: {
				cloudflareAccountId: this.env.CLOUDFLARE_ACCOUNT_ID ?? '',
				cloudflareApiToken: this.env.CLOUDFLARE_API_TOKEN ?? '',
				...(this.env.PROPUSTKA_URL !== undefined && this.env.PROPUSTKA_URL !== '' ? { propustkaUrl: this.env.PROPUSTKA_URL } : {}),
				...(this.env.PROPUSTKA_CLIENT_ID !== undefined && this.env.PROPUSTKA_CLIENT_ID !== '' ? { propustkaClientId: this.env.PROPUSTKA_CLIENT_ID } : {}),
				...(this.env.PROPUSTKA_CLIENT_SECRET !== undefined && this.env.PROPUSTKA_CLIENT_SECRET !== ''
					? { propustkaClientSecret: this.env.PROPUSTKA_CLIENT_SECRET }
					: {}),
			},
		}
	}

	/**
	 * Build the encrypted-vault handle from the `VOZKA_VAULT_KEY` Worker secret. Throws (caught by the
	 * caller as a clean error) when the key is missing/invalid — vault routes / `vault:` refs require it.
	 */
	private vault(): Promise<Vault> {
		if (this.env.VOZKA_VAULT_KEY === undefined) {
			return Promise.reject(new Error('VOZKA_VAULT_KEY is not set'))
		}
		return Vault.create(this.env.DB, this.env.VOZKA_VAULT_KEY)
	}

	/** Build the v1 RepoSource (GitHub App). The webhook secret + App key come from Worker secrets. */
	private repoSource(): RepoSource {
		return new GitHubAppRepoSource({
			appId: this.env.GITHUB_APP_ID ?? '',
			privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY ?? '',
			webhookSecret: this.env.GITHUB_WEBHOOK_SECRET ?? '',
		})
	}
}

export default Vozka
