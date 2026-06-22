import type { RunnerJob } from '@vozka/runner'
import { describe, expect, test } from 'bun:test'
import type { Db } from '../db'
import { uuidv7 } from '../db'
import { FakeRepoSource } from '../repo-source'
import { assembleJob, executeDeploy, type RunDeps, type RunOutcome } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

// End-to-end per-app secret injection through the vault: JobSpec assembly resolves every app secret
// through the encrypted vault (a real local D1 + a test master key), while the platform creds (CF
// account/token + propustka coords) come from vozka's build-time deploy config — so a deploy lands with
// the right secrets, and a wrong/missing secret ref FAILS the run loudly rather than deploying empty.

/** vozka's build-time platform deploy config — single CF account/token + propustka coords. */
const DEPLOY = {
	cloudflareAccountId: 'cf-acct-123',
	cloudflareApiToken: 'cf-token-xyz',
	propustkaUrl: 'https://iam.example',
	propustkaClientId: 'cid',
	propustkaClientSecret: 'csec',
}

function testKey(): string {
	const raw = new Uint8Array(32).fill(11)
	let binary = ''
	for (const b of raw) binary += String.fromCharCode(b)
	return btoa(binary)
}

function makeDeps(db: Db, vault: Vault, outcome: RunOutcome): { deps: RunDeps; jobs: RunnerJob[] } {
	const jobs: RunnerJob[] = []
	const deps: RunDeps = {
		db,
		repoSource: new FakeRepoSource(),
		secrets: new VaultSecretResolver({ vault }),
		deploy: DEPLOY,
		lock: makeFakeLock(),
		startRun: (job) => {
			jobs.push(job)
			return Promise.resolve(outcome)
		},
	}
	return { deps, jobs }
}

describe('JobSpec assembly through the vault', () => {
	test('injects platform creds + resolves per-env secrets from vault refs into the RunnerJob', async () => {
		const { db, d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())

		// Store the app secret VALUES in the vault, get back the refs to put on the rows.
		const apiKeyAllRef = await vault.putSecret('app', 'app:app/*/API_KEY', 'all-env-value')
		const apiKeyProdRef = await vault.putSecret('app-env', 'app-env:app/prod/API_KEY', 'prod-value')

		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app', workerDir: 'worker' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', domain: 'app.example.com' })
		await db.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef: apiKeyAllRef })
		await db.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: apiKeyProdRef })

		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'manual' })
		const run = await db.getRun(runId)
		const app = await db.getApp('app')
		const appEnv = await db.getAppEnv('app', 'prod')

		const job = await assembleJob(
			{
				db,
				repoSource: new FakeRepoSource(),
				secrets: new VaultSecretResolver({ vault }),
				deploy: DEPLOY,
				lock: makeFakeLock(),
				startRun: () => Promise.reject(new Error('unused')),
			},
			run!,
			app!,
			appEnv!,
		)

		// Platform creds come from the build-time deploy config (not the vault, not the registry).
		expect(job.credentials.CLOUDFLARE_ACCOUNT_ID).toBe('cf-acct-123')
		expect(job.credentials.CLOUDFLARE_API_TOKEN).toBe('cf-token-xyz')
		expect(job.credentials.PROPUSTKA_URL).toBe('https://iam.example')
		// The narrower env-specific secret wins over the all-env layer — decrypted from the vault.
		expect(job.secrets).toEqual({ API_KEY: 'prod-value' })
	})

	test('full executeDeploy resolves a vault-backed app secret and succeeds', async () => {
		const { db, d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const apiKeyRef = await vault.putSecret('app', 'app:app/*/API_KEY', 'SECRET-VALUE')
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod' })
		await db.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef: apiKeyRef })
		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })

		const { deps, jobs } = makeDeps(db, vault, { status: { state: 'succeeded', exitCode: 0 } })
		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('succeeded')
		expect(jobs[0]?.secrets).toEqual({ API_KEY: 'SECRET-VALUE' })
	})

	test('a dangling vault ref (deleted entry) FAILS the run, never deploys empty creds', async () => {
		const { db, d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const apiKeyRef = await vault.putSecret('app', 'l', 'SECRET-VALUE')
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod' })
		await db.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef: apiKeyRef })
		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })

		// Delete the vault entry the app secret points at → resolution must throw → run fails.
		await vault.delete(apiKeyRef)

		const { deps, jobs } = makeDeps(db, vault, { status: { state: 'succeeded' } })
		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('failed')
		expect(jobs).toHaveLength(0) // never reached startRun with an unresolved secret
		const failed = await db.getRun(runId)
		expect(failed?.status).toBe('failed')
	})
})
