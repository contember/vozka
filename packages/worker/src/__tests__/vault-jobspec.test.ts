import type { RunnerJob } from '@vozka/runner'
import { describe, expect, test } from 'bun:test'
import type { Db } from '../db'
import { uuidv7 } from '../db'
import { FakeRepoSource } from '../repo-source'
import { assembleJob, executeDeploy, type RunDeps, type RunOutcome } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { createHarness } from './helpers/harness'

// End-to-end M4 multi-account injection: the JobSpec assembly resolves the account's CF API token AND
// every app secret through the encrypted vault (a real local D1 + a test master key), so a deploy lands
// in the correct account with the right secrets — and a wrong/missing ref FAILS the run loudly rather
// than deploying empty creds.

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
		startRun: (job) => {
			jobs.push(job)
			return Promise.resolve(outcome)
		},
	}
	return { deps, jobs }
}

describe('JobSpec assembly through the vault', () => {
	test('resolves the account token + per-env secrets from vault refs into the RunnerJob', async () => {
		const { db, d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())

		// Store the credential VALUES in the vault, get back the refs to put on the rows.
		const tokenRef = await vault.putSecret('account', 'account:acc/cf_api_token', 'CF-TOKEN-SECRET')
		const apiKeyAllRef = await vault.putSecret('app', 'app:app/*/API_KEY', 'all-env-value')
		const apiKeyProdRef = await vault.putSecret('app-env', 'app-env:app/prod/API_KEY', 'prod-value')

		await db.createAccount({ name: 'acc', cfAccountId: 'cf-acct-123', cfApiTokenRef: tokenRef })
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app', workerDir: 'worker' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', accountName: 'acc', domain: 'app.example.com', propustkaUrl: 'https://iam.example' })
		await db.upsertAppSecret({ appId: 'app', env: null, name: 'API_KEY', valueRef: apiKeyAllRef })
		await db.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: apiKeyProdRef })

		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'manual' })
		const run = await db.getRun(runId)
		const app = await db.getApp('app')
		const appEnv = await db.getAppEnv('app', 'prod')

		const job = await assembleJob(
			{ db, repoSource: new FakeRepoSource(), secrets: new VaultSecretResolver({ vault }), startRun: () => Promise.reject(new Error('unused')) },
			run!,
			app!,
			appEnv!,
			{ cfAccountId: app!.id ? 'cf-acct-123' : '', cfApiTokenRef: tokenRef },
		)

		// The account creds land in credentials; the decrypted token reaches the job.
		expect(job.credentials.CLOUDFLARE_ACCOUNT_ID).toBe('cf-acct-123')
		expect(job.credentials.CLOUDFLARE_API_TOKEN).toBe('CF-TOKEN-SECRET')
		expect(job.credentials.PROPUSTKA_URL).toBe('https://iam.example')
		// The narrower env-specific secret wins over the all-env layer.
		expect(job.secrets).toEqual({ API_KEY: 'prod-value' })
	})

	test('full executeDeploy resolves vault creds and succeeds', async () => {
		const { db, d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const tokenRef = await vault.putSecret('account', 'l', 'CF-TOKEN')
		await db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: tokenRef })
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', accountName: 'acc' })
		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })

		const { deps, jobs } = makeDeps(db, vault, { status: { state: 'succeeded', exitCode: 0 } })
		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('succeeded')
		expect(jobs[0]?.credentials.CLOUDFLARE_API_TOKEN).toBe('CF-TOKEN')
	})

	test('a dangling vault ref (deleted entry) FAILS the run, never deploys empty creds', async () => {
		const { db, d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const tokenRef = await vault.putSecret('account', 'l', 'CF-TOKEN')
		await db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: tokenRef })
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', accountName: 'acc' })
		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })

		// Delete the vault entry the account token points at → resolution must throw → run fails.
		await vault.delete(tokenRef)

		const { deps, jobs } = makeDeps(db, vault, { status: { state: 'succeeded' } })
		const result = await executeDeploy(deps, { runId })

		expect(result.status).toBe('failed')
		expect(jobs).toHaveLength(0) // never reached startRun with empty creds
		const failed = await db.getRun(runId)
		expect(failed?.status).toBe('failed')
	})
})
