// Run lifecycle — the testable core that turns a queued deploy into a `RunnerJob`, executes it, and
// drives the `runs` row through its states. Decoupled from the Worker/Queue/DO so it's unit-testable
// with a FakeRepoSource, a fake SecretResolver, and a fake `startRun` (no Cloudflare, no container).
//
// RUN LIFECYCLE (states + who writes them):
//   pending   — written by the TRIGGER (webhook handler / triggerDeploy RPC) via Db.createRun, then
//               the job is enqueued. The row exists before the queue is touched, so a trigger is
//               durable even if the queue delivery is delayed.
//   running   — written HERE by Db.markRunStarted (status guard: only pending → running), stamping
//               started_at + the R2 log key, right before startRun. The guard makes a redelivered
//               queue message a no-op (it won't re-run an already-started run).
//   succeeded — written HERE by Db.markRunFinished after startRun reports a terminal 'succeeded'.
//   failed    — written HERE by Db.markRunFinished on a terminal 'failed' OR when assembly/startRun
//               throws (clone/secret-resolution/relay error). The exit code is the runner's, or null.
//
// The relay (M2) already streams logs + terminal status to R2 under runs/<id>/*. This module records
// the SAME terminal outcome into D1 so the dashboard reads run history from D1 and the log from R2.

import type { RunnerJob } from '@vozka/runner'
import { type AppEnvRow, type AppRow, type Db, type RunRow } from './db'
import { logsKey } from './relay'
import type { RepoSource } from './repo-source'
import type { SecretResolver } from './secret-resolver'

/** The terminal outcome `startRun` reports (the slice run-lifecycle needs of M2's `RelayResult`). */
export interface RunOutcome {
	status: { state: 'succeeded' | 'failed'; exitCode?: number }
}

/** The injected runner: M2's `Vozka.startRun`. Typed structurally so tests pass a fake. */
export type StartRun = (job: RunnerJob) => Promise<RunOutcome>

/**
 * vozka's build-time deploy config — the platform credentials + propustka coordinates injected into
 * EVERY deploy job, sourced from vozka's own Worker vars/secrets (not the per-app registry). vozka is
 * single-account, so there is one CF account + token for the whole control plane; the propustka coords
 * are the one propustka this account runs. WHETHER a deploy reconciles is decided by the app's config
 * (`access`/`schema` presence) — these are always available; an app without access/schema ignores them.
 */
export interface DeployConfig {
	/** The CF account id every deploy targets. */
	cloudflareAccountId: string
	/** The CF API token every deploy uses (account-wide). Never logged. */
	cloudflareApiToken: string
	/** propustka IAM base URL for the reconcile step, when configured. */
	propustkaUrl?: string
	/** propustka admin OAuth client id (vozka's provisioning key), when configured. Never logged. */
	propustkaClientId?: string
	/** propustka admin OAuth client secret, when configured. Never logged. */
	propustkaClientSecret?: string
}

/** Everything the lifecycle needs, injected so the core is pure + testable. */
export interface RunDeps {
	db: Db
	repoSource: RepoSource
	secrets: SecretResolver
	startRun: StartRun
	/** vozka's own platform deploy config (CF account/token + propustka coords), build-time. */
	deploy: DeployConfig
}

/**
 * Assemble the `RunnerJob` for a run: inject vozka's build-time platform credentials (CF account/token
 * + propustka coords) and resolve the app's per-app secret values through the SecretResolver (the
 * vault seam), then build the clone URL through the RepoSource. Credentials + secret VALUES are placed
 * on the job and never logged. `dryRun` flows through so a plan-only run never mutates Cloudflare.
 */
export async function assembleJob(
	deps: RunDeps,
	run: RunRow,
	app: AppRow,
	appEnv: AppEnvRow,
	options: { dryRun?: boolean } = {},
): Promise<RunnerJob> {
	// Fail loud rather than deploy with an empty credential (same invariant as the secret resolver).
	if (deps.deploy.cloudflareAccountId === '' || deps.deploy.cloudflareApiToken === '') {
		throw new Error('Cloudflare credentials not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN)')
	}

	const cloneTarget = await deps.repoSource.clone(app.repo_url, run.ref, app.github_installation_id)

	// Resolve the app's secrets for THIS env (narrower env-specific layer wins over the all-env layer).
	const secretRows = await deps.db.getAppSecretsForEnv(app.id, appEnv.env)
	const secrets: Record<string, string> = {}
	for (const row of secretRows) {
		// A concrete-env row overwrites the all-env row of the same name (rows are ordered by name,
		// then the env-specific row, last write wins). We resolve every row's ref through the seam.
		secrets[row.name] = await deps.secrets.resolveSecret(row.value_ref)
	}

	const job: RunnerJob = {
		runId: run.id,
		repoUrl: cloneTarget.cloneUrl,
		ref: cloneTarget.ref,
		env: appEnv.env,
		credentials: {
			CLOUDFLARE_ACCOUNT_ID: deps.deploy.cloudflareAccountId,
			CLOUDFLARE_API_TOKEN: deps.deploy.cloudflareApiToken,
			...(deps.deploy.propustkaUrl !== undefined ? { PROPUSTKA_URL: deps.deploy.propustkaUrl } : {}),
			...(deps.deploy.propustkaClientId !== undefined ? { PROPUSTKA_CLIENT_ID: deps.deploy.propustkaClientId } : {}),
			...(deps.deploy.propustkaClientSecret !== undefined ? { PROPUSTKA_CLIENT_SECRET: deps.deploy.propustkaClientSecret } : {}),
		},
		...(app.worker_dir !== null ? { workerDir: app.worker_dir } : {}),
		...(app.config_path !== null ? { configPath: app.config_path } : {}),
		...(appEnv.domain !== null ? { domain: appEnv.domain } : {}),
		...(options.dryRun ? { dryRun: true } : {}),
		...(Object.keys(secrets).length > 0 ? { secrets } : {}),
	}
	return job
}

/** What the queue carries — the minimal pointer to a pending run row. */
export interface DeployJobMessage {
	runId: string
	dryRun?: boolean
}

/**
 * Execute one queued deploy: load the run + app + env, transition pending → running,
 * assemble + run the job, then record the terminal outcome. Returns the final status so the queue
 * consumer can decide ack/retry. Throws are caught and recorded as a `failed` run (never re-thrown to
 * the queue as an infinite retry of an unrecoverable assembly error).
 */
export async function executeDeploy(
	deps: RunDeps,
	message: DeployJobMessage,
): Promise<{ runId: string; status: 'running' | 'succeeded' | 'failed' | 'skipped' }> {
	const run = await deps.db.getRun(message.runId)
	if (run === null) {
		// The row was deleted (e.g. its app was removed) — nothing to do; ack the message.
		return { runId: message.runId, status: 'skipped' }
	}
	// Status guard: only a still-pending run is started. A redelivered message for an already-running
	// or terminal run is a no-op (idempotent consumer).
	const started = await deps.db.markRunStarted(run.id, logsKey(run.id))
	if (!started) {
		return { runId: run.id, status: 'skipped' }
	}

	try {
		const app = await deps.db.getApp(run.app_id)
		const appEnv = await deps.db.getAppEnv(run.app_id, run.env)
		if (app === null || appEnv === null) {
			await deps.db.markRunFinished(run.id, 'failed', null)
			return { runId: run.id, status: 'failed' }
		}

		const job = await assembleJob(deps, run, app, appEnv, { ...(message.dryRun ? { dryRun: true } : {}) })

		const outcome = await deps.startRun(job)
		const status = outcome.status.state
		await deps.db.markRunFinished(run.id, status, outcome.status.exitCode ?? null)
		return { runId: run.id, status }
	} catch (err) {
		// Assembly / relay failure: record the run as failed (no exit code — the deploy child may
		// never have run). Never log the error object verbatim — it could carry a clone URL with an
		// embedded token; log a short message only.
		console.error(`deploy run ${run.id} failed:`, err instanceof Error ? err.message : 'unknown error')
		await deps.db.markRunFinished(run.id, 'failed', null)
		return { runId: run.id, status: 'failed' }
	}
}

/**
 * Map a pushed git ref to the (app, env) it triggers. The webhook first narrows to the app(s) for the
 * pushed repo, then this matches the ref against each app's env trigger_refs. Pure + unit-tested.
 * Returns the matched env name, or null when no env subscribes to this ref.
 */
export async function refToEnv(db: Db, appId: string, ref: string): Promise<AppEnvRow | null> {
	return db.getAppEnvByTriggerRef(appId, ref)
}
