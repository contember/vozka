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

/** A persona granting exactly `secret.manage` + `app.manage` globally (covers the app-secret values). */
function secretManager(): FakeIamClient {
	return new FakeIamClient({
		personas: {
			'sm@vozka.test': {
				id: 'p-sm',
				label: 'sm@vozka.test',
				type: 'user',
				permissions: [
					{ action: 'secret.manage', scope: null, source: 'grant' },
					{ action: 'app.manage', scope: null, source: 'grant' },
				],
			},
		},
		defaultPersona: 'sm@vozka.test',
	})
}

describe('app secret value endpoints (secret.manage, app-scoped)', () => {
	async function seedApp(deps: ApiDeps): Promise<void> {
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.db.upsertAppEnv({ appId: 'app', env: 'prod' })
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
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { value: 'x' }), deps)
		expect(response.status).toBe(500)
	})
})
