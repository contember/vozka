import type { RunnerJob } from '@vozka/runner'
import { describe, expect, test } from 'bun:test'
import type { Db } from '../db'
import { uuidv7 } from '../db'
import { FakeRepoSource } from '../repo-source'
import { assembleJob, type DeployJobMessage, executeDeploy, type RunDeps, type RunOutcome } from '../run-lifecycle'
import { EnvSecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'

// The run lifecycle is the testable core of the queue consumer. These tests drive it with a
// FakeRepoSource, a fake SecretResolver, and a fake startRun — no Cloudflare, no container — covering
// (1) job assembly (creds + secrets resolved through the seam, never on argv/logged), and (2) the
// run-row state transitions (pending → running → succeeded|failed, with the idempotent status guard).

/** Seed account + app (one secret) + env; return the created pending run row. */
async function seedRun(db: Db, options: { dryRun?: boolean; commitSha?: string } = {}): Promise<{ runId: string }> {
	await db.createAccount({ name: 'acc', cfAccountId: 'cf-acct-123', cfApiTokenRef: 'literal:cf-token-xyz' })
	await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app', workerDir: 'worker', configPath: 'vozka.config.ts' })
	await db.upsertAppEnv({ appId: 'app', env: 'prod', accountName: 'acc', domain: 'app.example.com', propustkaUrl: 'https://iam.example' })
	await db.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef: 'literal:all-env-value' })
	await db.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: 'literal:prod-value' })
	const runId = uuidv7()
	await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'manual', commitSha: options.commitSha ?? null })
	return { runId }
}

/** Build deps with a recording fake startRun returning the given terminal outcome. */
function makeDeps(db: Db, outcome: RunOutcome): { deps: RunDeps; jobs: RunnerJob[] } {
	const jobs: RunnerJob[] = []
	const deps: RunDeps = {
		db,
		repoSource: new FakeRepoSource(),
		secrets: new EnvSecretResolver({}),
		startRun: (job) => {
			jobs.push(job)
			return Promise.resolve(outcome)
		},
	}
	return { deps, jobs }
}

describe('assembleJob', () => {
	test('resolves account token + per-env secrets (narrower env wins) into the RunnerJob', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const run = await db.getRun(runId)
		const app = await db.getApp('app')
		const appEnv = await db.getAppEnv('app', 'prod')
		const secrets = new EnvSecretResolver({})

		const job = await assembleJob(
			{ db, repoSource: new FakeRepoSource(), secrets, startRun: () => Promise.reject(new Error('unused')) },
			run!,
			app!,
			appEnv!,
			{ cfAccountId: app ? 'cf-acct-123' : '', cfApiTokenRef: 'literal:cf-token-xyz' },
		)

		expect(job.runId).toBe(runId)
		expect(job.env).toBe('prod')
		expect(job.repoUrl).toBe('github.com/acme/app')
		expect(job.workerDir).toBe('worker')
		expect(job.configPath).toBe('vozka.config.ts')
		expect(job.domain).toBe('app.example.com')
		expect(job.credentials.CLOUDFLARE_ACCOUNT_ID).toBe('cf-acct-123')
		expect(job.credentials.CLOUDFLARE_API_TOKEN).toBe('cf-token-xyz')
		expect(job.credentials.PROPUSTKA_URL).toBe('https://iam.example')
		// The env-specific secret layer wins over the all-env layer for the same name.
		expect(job.secrets).toEqual({ API_KEY: 'prod-value' })
	})

	test('dryRun flows through to the job', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const run = await db.getRun(runId)
		const app = await db.getApp('app')
		const appEnv = await db.getAppEnv('app', 'prod')
		const job = await assembleJob(
			{ db, repoSource: new FakeRepoSource(), secrets: new EnvSecretResolver({}), startRun: () => Promise.reject(new Error('x')) },
			run!,
			app!,
			appEnv!,
			{ cfAccountId: 'cf-acct-123', cfApiTokenRef: 'literal:cf-token-xyz' },
			{ dryRun: true },
		)
		expect(job.dryRun).toBe(true)
	})

	test('embeds an installation clone token when the app has an installation id', async () => {
		const { db } = createHarness()
		await db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: 'literal:t' })
		await db.createApp({ id: 'app', repoUrl: 'https://github.com/acme/app.git', githubInstallationId: 42 })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', accountName: 'acc' })
		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		const run = await db.getRun(runId)
		const app = await db.getApp('app')
		const appEnv = await db.getAppEnv('app', 'prod')

		const job = await assembleJob(
			{
				db,
				repoSource: new FakeRepoSource({ fakeToken: 'ghs-installtok' }),
				secrets: new EnvSecretResolver({}),
				startRun: () => Promise.reject(new Error('x')),
			},
			run!,
			app!,
			appEnv!,
			{ cfAccountId: 'cf', cfApiTokenRef: 'literal:t' },
		)
		expect(job.repoUrl).toContain('x-access-token:ghs-installtok@')
	})
})

describe('executeDeploy (run-row state transitions)', () => {
	test('pending → running → succeeded; records the exit code', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const { deps, jobs } = makeDeps(db, { status: { state: 'succeeded', exitCode: 0 } })

		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('succeeded')
		expect(jobs).toHaveLength(1)
		const run = await db.getRun(runId)
		expect(run?.status).toBe('succeeded')
		expect(run?.exit_code).toBe(0)
		expect(run?.started_at).not.toBeNull()
		expect(run?.finished_at).not.toBeNull()
		expect(run?.log_key).toBe(`runs/${runId}/logs.ndjson`)
	})

	test('pending → running → failed; records the failure exit code', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const { deps } = makeDeps(db, { status: { state: 'failed', exitCode: 1 } })

		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('failed')
		const run = await db.getRun(runId)
		expect(run?.status).toBe('failed')
		expect(run?.exit_code).toBe(1)
		expect(run?.finished_at).not.toBeNull()
	})

	test('a redelivered message for an already-running run is a no-op (idempotent guard)', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		// First delivery wins and starts the run.
		await db.markRunStarted(runId, `runs/${runId}/logs.ndjson`)
		const { deps, jobs } = makeDeps(db, { status: { state: 'succeeded', exitCode: 0 } })

		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('skipped')
		expect(jobs).toHaveLength(0) // never ran the job a second time
	})

	test('a missing run row is skipped (its app was deleted)', async () => {
		const { db } = createHarness()
		const { deps } = makeDeps(db, { status: { state: 'succeeded' } })
		const result = await executeDeploy(deps, { runId: 'nonexistent' })
		expect(result.status).toBe('skipped')
	})

	test('an assembly error (unresolvable token) records the run as failed, never throws', async () => {
		const { db } = createHarness()
		// Account token ref points at an env var that does not exist → resolver throws.
		await db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: 'env:MISSING' })
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', accountName: 'acc' })
		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		const { deps } = makeDeps(db, { status: { state: 'succeeded' } })

		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('failed')
		const run = await db.getRun(runId)
		expect(run?.status).toBe('failed')
		expect(run?.exit_code).toBeNull()
	})

	test('dryRun on the message flows into the assembled job', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const { deps, jobs } = makeDeps(db, { status: { state: 'succeeded', exitCode: 0 } })
		const message: DeployJobMessage = { runId, dryRun: true }
		await executeDeploy(deps, message)
		expect(jobs[0]?.dryRun).toBe(true)
	})
})
