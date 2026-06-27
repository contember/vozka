import type { RunnerJob } from '@vozka/runner'
import { describe, expect, test } from 'bun:test'
import type { Db } from '../db'
import { uuidv7 } from '../db'
import { FakeRepoSource } from '../repo-source'
import { assembleJob, type DeployJobMessage, executeDeploy, type RunDeps, type RunOutcome } from '../run-lifecycle'
import { EnvSecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

// The run lifecycle is the testable core of the queue consumer. These tests drive it with a
// FakeRepoSource, a fake SecretResolver, and a fake startRun — no Cloudflare, no container — covering
// (1) job assembly (creds + secrets resolved through the seam, never on argv/logged), and (2) the
// run-row state transitions (pending → running → succeeded|failed, with the idempotent status guard).

/** vozka's build-time platform deploy config — single CF account/token + propustka coords. */
const DEPLOY = {
	cloudflareAccountId: 'cf-acct-123',
	cloudflareApiToken: 'cf-token-xyz',
	propustkaUrl: 'https://iam.example',
	propustkaProvisioningKey: 'px_provision',
}

/** Seed app (one secret) + env; return the created pending run row. */
async function seedRun(db: Db, options: { dryRun?: boolean; commitSha?: string } = {}): Promise<{ runId: string }> {
	await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app', workerDir: 'worker', configPath: 'vozka.config.ts' })
	await db.upsertAppEnv({ appId: 'app', env: 'prod', domain: 'app.example.com' })
	await db.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef: 'literal:all-env-value' })
	await db.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: 'literal:prod-value' })
	const runId = uuidv7()
	await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'manual', commitSha: options.commitSha ?? null })
	return { runId }
}

/** Build deps with a recording fake startRun returning the given terminal outcome + an in-memory lock. */
function makeDeps(
	db: Db,
	outcome: RunOutcome,
	lock = makeFakeLock(),
): { deps: RunDeps; jobs: RunnerJob[]; lock: ReturnType<typeof makeFakeLock> } {
	const jobs: RunnerJob[] = []
	const deps: RunDeps = {
		db,
		repoSource: new FakeRepoSource(),
		secrets: new EnvSecretResolver({}),
		deploy: DEPLOY,
		lock,
		startRun: (job) => {
			jobs.push(job)
			return Promise.resolve(outcome)
		},
	}
	return { deps, jobs, lock }
}

describe('assembleJob', () => {
	test('injects platform creds + resolves per-env secrets (narrower env wins) into the RunnerJob', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const run = await db.getRun(runId)
		const app = await db.getApp('app')
		const appEnv = await db.getAppEnv('app', 'prod')
		const secrets = new EnvSecretResolver({})

		const job = await assembleJob(
			{ db, repoSource: new FakeRepoSource(), secrets, deploy: DEPLOY, lock: makeFakeLock(), startRun: () => Promise.reject(new Error('unused')) },
			run!,
			app!,
			appEnv!,
		)

		expect(job.runId).toBe(runId)
		expect(job.env).toBe('prod')
		expect(job.repoUrl).toBe('github.com/acme/app')
		expect(job.workerDir).toBe('worker')
		expect(job.configPath).toBe('vozka.config.ts')
		expect(job.domain).toBe('app.example.com')
		// Platform creds come from the build-time deploy config, not the registry.
		expect(job.credentials.CLOUDFLARE_ACCOUNT_ID).toBe('cf-acct-123')
		expect(job.credentials.CLOUDFLARE_API_TOKEN).toBe('cf-token-xyz')
		expect(job.credentials.PROPUSTKA_URL).toBe('https://iam.example')
		expect(job.credentials.PROPUSTKA_PROVISIONING_KEY).toBe('px_provision')
		// The env-specific secret layer wins over the all-env layer for the same name.
		expect(job.secrets).toEqual({ API_KEY: 'prod-value' })
	})

	test('resolves per-env NON-secret vars (narrower env wins, plaintext, no vault) into the RunnerJob', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', domain: 'app.example.com' })
		// All-env layer + a prod override of the same name; the env-specific value must win.
		await db.upsertAppVar({ appId: 'app', env: null, name: 'TEAM', value: 'all-env-team' })
		await db.upsertAppVar({ appId: 'app', env: 'prod', name: 'TEAM', value: 'prod-team' })
		await db.upsertAppVar({ appId: 'app', env: null, name: 'ACCESS_APPS', value: '{"aud":"app"}' })
		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'manual', commitSha: null })

		const job = await assembleJob(
			{
				db,
				repoSource: new FakeRepoSource(),
				secrets: new EnvSecretResolver({}),
				deploy: DEPLOY,
				lock: makeFakeLock(),
				startRun: () => Promise.reject(new Error('unused')),
			},
			(await db.getRun(runId))!,
			(await db.getApp('app'))!,
			(await db.getAppEnv('app', 'prod'))!,
		)

		// Plaintext values straight from the registry; env-specific wins over all-env; no vault resolution.
		expect(job.vars).toEqual({ ACCESS_APPS: '{"aud":"app"}', TEAM: 'prod-team' })
	})

	test('dryRun flows through to the job', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const run = await db.getRun(runId)
		const app = await db.getApp('app')
		const appEnv = await db.getAppEnv('app', 'prod')
		const job = await assembleJob(
			{
				db,
				repoSource: new FakeRepoSource(),
				secrets: new EnvSecretResolver({}),
				deploy: DEPLOY,
				lock: makeFakeLock(),
				startRun: () => Promise.reject(new Error('x')),
			},
			run!,
			app!,
			appEnv!,
			{ dryRun: true },
		)
		expect(job.dryRun).toBe(true)
	})

	test('throws when the platform CF credentials are unconfigured (never deploy empty)', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const run = await db.getRun(runId)
		const app = await db.getApp('app')
		const appEnv = await db.getAppEnv('app', 'prod')
		const emptyDeploy = { ...DEPLOY, cloudflareApiToken: '' }
		await expect(
			assembleJob(
				{
					db,
					repoSource: new FakeRepoSource(),
					secrets: new EnvSecretResolver({}),
					deploy: emptyDeploy,
					lock: makeFakeLock(),
					startRun: () => Promise.reject(new Error('x')),
				},
				run!,
				app!,
				appEnv!,
			),
		).rejects.toThrow(/Cloudflare credentials not configured/)
	})

	test('embeds an installation clone token when the app has an installation id', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'https://github.com/acme/app.git', githubInstallationId: 42 })
		await db.upsertAppEnv({ appId: 'app', env: 'prod' })
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
				deploy: DEPLOY,
				lock: makeFakeLock(),
				startRun: () => Promise.reject(new Error('x')),
			},
			run!,
			app!,
			appEnv!,
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

	test('an assembly error (unresolvable secret ref) records the run as failed, never throws', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod' })
		// Secret ref points at an env var that does not exist → resolveSecret throws during assembly.
		await db.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef: 'env:MISSING' })
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

describe('executeDeploy (per-app-env deploy lock)', () => {
	test('takes the app-env lock, runs, then releases it on success', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const { deps, lock } = makeDeps(db, { status: { state: 'succeeded', exitCode: 0 } })

		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('succeeded')
		expect(lock.held.size).toBe(0) // released
	})

	test('releases the app-env lock after a failed run', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const { deps, lock } = makeDeps(db, { status: { state: 'failed', exitCode: 1 } })

		await executeDeploy(deps, { runId })

		expect(lock.held.size).toBe(0)
	})

	test('defers (leaves the run pending, never starts) when another deploy holds the app-env lock', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const lock = makeFakeLock()
		// A concurrent deploy of the SAME app-env already holds the lock.
		await lock.acquire('app:prod', 'other-run')
		const { deps, jobs } = makeDeps(db, { status: { state: 'succeeded', exitCode: 0 } }, lock)

		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('deferred')
		expect(jobs).toHaveLength(0) // never started the job
		const run = await db.getRun(runId)
		expect(run?.status).toBe('pending') // still pending — the consumer re-enqueues it
		// The other deploy's lease is untouched (non-reentrant acquire; no steal, no release).
		expect(lock.held.get('app:prod')).toBe('other-run')
	})

	test('a deferred run proceeds once the lock frees (the re-enqueue path)', async () => {
		const { db } = createHarness()
		const { runId } = await seedRun(db)
		const lock = makeFakeLock()
		await lock.acquire('app:prod', 'other-run')
		const { deps, jobs } = makeDeps(db, { status: { state: 'succeeded', exitCode: 0 } }, lock)

		// First delivery defers (lock held by the other deploy)…
		expect((await executeDeploy(deps, { runId })).status).toBe('deferred')
		// …the other deploy finishes and frees the slot…
		await lock.release('app:prod', 'other-run')
		// …and the re-delivered message now runs to completion.
		const result = await executeDeploy(deps, { runId })
		expect(result.status).toBe('succeeded')
		expect(jobs).toHaveLength(1)
		expect(lock.held.size).toBe(0)
	})
})
