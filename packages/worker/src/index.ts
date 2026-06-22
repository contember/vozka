import { isRunnerJob, type RunnerJob } from '@vozka/runner'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { handleApi } from './api/router'
import { Db } from './db'
import type { Env } from './env'
import { createIam } from './iam'
import { type ContainerLike, type RelayResult, relayRun } from './relay'
import { GitHubAppRepoSource, type RepoSource } from './repo-source'
import { type DeployJobMessage, executeDeploy, type RunDeps, type RunOutcome } from './run-lifecycle'
import { EnvSecretResolver } from './secret-resolver'
import { handleWebhook } from './webhook'

export { RunnerContainer } from './RunnerContainer'

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
			return Response.json({ status: 'ok', service: 'vozka', milestone: 'M3a' })
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

		// The ACL-gated control surface (registry / runs / triggers).
		if (url.pathname.startsWith('/api/')) {
			return handleApi(request, {
				db: new Db(this.env.DB),
				iam: createIam(this.env),
				queue: this.env.DEPLOY_QUEUE,
				logs: this.env.RUN_LOGS,
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
		const deps = this.runDeps()
		for (const message of batch.messages) {
			try {
				await executeDeploy(deps, message.body)
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
	private runDeps(): RunDeps {
		const startRun = async (job: RunnerJob): Promise<RunOutcome> => {
			const result = await this.startRun(job)
			// The relay only resolves on a terminal status; narrow its state to the lifecycle's union.
			const state = result.status.state === 'succeeded' ? 'succeeded' : 'failed'
			return { status: { state, ...(result.status.exitCode !== undefined ? { exitCode: result.status.exitCode } : {}) } }
		}
		return {
			db: new Db(this.env.DB),
			repoSource: this.repoSource(),
			// TODO(M4): swap EnvSecretResolver for the vault-backed resolver (per-account key, rotation).
			// For now refs resolve against the Worker's own secret bindings (env:NAME) / literals.
			secrets: new EnvSecretResolver({
				GITHUB_WEBHOOK_SECRET: this.env.GITHUB_WEBHOOK_SECRET,
				GITHUB_APP_ID: this.env.GITHUB_APP_ID,
			}),
			startRun,
		}
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
