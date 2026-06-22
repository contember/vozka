import { FakeIamClient } from '@propustka/client'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import type { DeployJobMessage } from '../run-lifecycle'
import { parseVaultRef, Vault } from '../vault'
import { createHarness } from './helpers/harness'

// The vault MANAGEMENT API (M4): write-only set/rotate/delete of secret VALUES, gated by `secret.manage`
// and audited. These assert: the value is stored in the vault + the ref written back to the row; the
// value is NEVER returned in any API response; the ACL is enforced (allow + 403); and a value the API
// stored decrypts back through the vault (so the JobSpec path will resolve it).

function testKey(): string {
	const raw = new Uint8Array(32).fill(3)
	let binary = ''
	for (const b of raw) binary += String.fromCharCode(b)
	return btoa(binary)
}

/** Router deps over a real sqlite D1, a recording queue, and a vault factory bound to the SAME db. */
function makeDeps(iam: FakeIamClient): { deps: ApiDeps; vault: Promise<Vault>; queue: DeployJobMessage[] } {
	const { db, d1 } = createHarness()
	const queue: DeployJobMessage[] = []
	const vault = Vault.create(d1, testKey())
	const deps: ApiDeps = {
		db,
		iam,
		queue: {
			send(m) {
				queue.push(m)
				return Promise.resolve()
			},
		},
		logs: { get: () => Promise.resolve(null) },
		vault: () => vault,
	}
	return { deps, vault, queue }
}

function req(method: string, path: string, body?: unknown): Request {
	return new Request(`https://vozka.example${path}`, {
		method,
		...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
	})
}

/** A persona granting exactly `secret.manage` globally (covers both account-token + app-secret values). */
function secretManager(): FakeIamClient {
	return new FakeIamClient({
		personas: {
			'sm@vozka.test': {
				id: 'p-sm',
				label: 'sm@vozka.test',
				type: 'user',
				permissions: [{ action: 'secret.manage', scope: null, source: 'grant' }, { action: 'account.manage', scope: null, source: 'grant' }, {
					action: 'app.manage',
					scope: null,
					source: 'grant',
				}],
			},
		},
		defaultPersona: 'sm@vozka.test',
	})
}

describe('account token value endpoints (secret.manage)', () => {
	test('PUT stores the value in the vault, writes the ref back, never returns the value', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await deps.db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: 'env:BOOTSTRAP' })

		const response = await handleApi(req('PUT', '/api/accounts/acc/token', { value: 'CF-API-TOKEN-XYZ' }), deps)
		expect(response.status).toBe(200)
		const text = await response.text()
		expect(text).not.toContain('CF-API-TOKEN-XYZ') // write-only: value never echoed

		const account = await deps.db.getAccount('acc')
		expect(parseVaultRef(account!.cf_api_token_ref)).not.toBeNull() // ref written back onto the row
		// The stored value decrypts through the vault (so the JobSpec path will resolve it).
		expect(await (await vault).getSecret(account!.cf_api_token_ref)).toBe('CF-API-TOKEN-XYZ')
	})

	test('PATCH rotates the value in place; PUT replaces and drops the old vault entry', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await deps.db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: 'env:BOOTSTRAP' })

		await handleApi(req('PUT', '/api/accounts/acc/token', { value: 'v1' }), deps)
		const firstRef = (await deps.db.getAccount('acc'))!.cf_api_token_ref

		const rotate = await handleApi(req('PATCH', '/api/accounts/acc/token', { value: 'v2' }), deps)
		expect(rotate.status).toBe(200)
		expect(await (await vault).getSecret(firstRef)).toBe('v2') // same ref, new value

		// A PUT replaces the entry with a new ref and drops the old one.
		const put = await handleApi(req('PUT', '/api/accounts/acc/token', { value: 'v3' }), deps)
		expect(put.status).toBe(200)
		const secondRef = (await deps.db.getAccount('acc'))!.cf_api_token_ref
		expect(secondRef).not.toBe(firstRef)
		await expect((await vault).getSecret(firstRef)).rejects.toThrow() // old entry deleted
		expect(await (await vault).getSecret(secondRef)).toBe('v3')
	})

	test('rotate before set is a 409 (not a vault ref yet)', async () => {
		const { deps } = makeDeps(secretManager())
		await deps.db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: 'env:BOOTSTRAP' })
		const response = await handleApi(req('PATCH', '/api/accounts/acc/token', { value: 'x' }), deps)
		expect(response.status).toBe(409)
	})

	test('a caller denied secret.manage gets 403 (account token)', async () => {
		const { deps } = makeDeps(new FakeIamClient({ deny: ['secret.manage'] }))
		await deps.db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: 'env:BOOTSTRAP' })
		const response = await handleApi(req('PUT', '/api/accounts/acc/token', { value: 'x' }), deps)
		expect(response.status).toBe(403)
	})
})

describe('app secret value endpoints (secret.manage, app-scoped)', () => {
	async function seedApp(deps: ApiDeps): Promise<void> {
		await deps.db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: 'env:T' })
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.db.upsertAppEnv({ appId: 'app', env: 'prod', accountName: 'acc' })
	}

	test('PUT .../secrets/:name/value stores in the vault + upserts the ref; value not returned', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)

		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { value: 'the-real-key', env: 'prod' }), deps)
		expect(response.status).toBe(200)
		expect(await response.text()).not.toContain('the-real-key')

		const secrets = await deps.db.listAppSecrets('app')
		const prod = secrets.find((s) => s.name === 'API_KEY' && s.env === 'prod')
		expect(prod).toBeDefined()
		expect(parseVaultRef(prod!.value_ref)).not.toBeNull()
		expect(await (await vault).getSecret(prod!.value_ref)).toBe('the-real-key')
	})

	test('all-env layer (no env) and PATCH rotate', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)
		await handleApi(req('PUT', '/api/apps/app/secrets/SHARED/value', { value: 'shared-v1' }), deps)
		const allEnv = (await deps.db.listAppSecrets('app')).find((s) => s.name === 'SHARED' && s.env === null)
		expect(allEnv).toBeDefined()

		const rotate = await handleApi(req('PATCH', '/api/apps/app/secrets/SHARED/value', { value: 'shared-v2' }), deps)
		expect(rotate.status).toBe(200)
		expect(await (await vault).getSecret(allEnv!.value_ref)).toBe('shared-v2')
	})

	test('DELETE drops the vault entry', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)
		await handleApi(req('PUT', '/api/apps/app/secrets/GONE/value', { value: 'bye' }), deps)
		const ref = (await deps.db.listAppSecrets('app')).find((s) => s.name === 'GONE')!.value_ref
		const del = await handleApi(req('DELETE', '/api/apps/app/secrets/GONE/value'), deps)
		expect(del.status).toBe(200)
		await expect((await vault).getSecret(ref)).rejects.toThrow()
	})

	test('a caller denied secret.manage gets 403 (app secret value)', async () => {
		const { deps } = makeDeps(new FakeIamClient({ deny: ['secret.manage'] }))
		await seedApp(deps)
		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { value: 'x' }), deps)
		expect(response.status).toBe(403)
	})

	test('missing value → 400', async () => {
		const { deps } = makeDeps(secretManager())
		await seedApp(deps)
		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { env: 'prod' }), deps)
		expect(response.status).toBe(400)
	})
})

describe('vault not configured', () => {
	test('vault routes 500 cleanly when no vault factory is wired', async () => {
		const { db } = createHarness()
		const deps: ApiDeps = {
			db,
			iam: secretManager(),
			queue: { send: () => Promise.resolve() },
			logs: { get: () => Promise.resolve(null) },
			// no `vault` factory
		}
		await db.createAccount({ name: 'acc', cfAccountId: 'cf', cfApiTokenRef: 'env:T' })
		const response = await handleApi(req('PUT', '/api/accounts/acc/token', { value: 'x' }), deps)
		expect(response.status).toBe(500)
	})
})
