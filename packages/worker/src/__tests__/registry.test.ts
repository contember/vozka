import { FakeIamClient } from '@propustka/client'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { uuidv7 } from '../db'
import { logsKey } from '../relay'
import type { DeployJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'

// Registry + onboarding row creation, and run-history reads, driven through the real `handleApi`
// router against the real schema (in-memory sqlite). An allow-all FakeIamClient lets us focus on the
// data path here; ACL is covered separately in acl.test.ts.

function makeDeps(): { deps: ApiDeps; queue: DeployJobMessage[]; logStore: Map<string, string> } {
	const { db } = createHarness()
	const queue: DeployJobMessage[] = []
	const logStore = new Map<string, string>()
	const deps: ApiDeps = {
		db,
		iam: new FakeIamClient(),
		queue: {
			send(m) {
				queue.push(m)
				return Promise.resolve()
			},
		},
		logs: {
			get: (key) => {
				const v = logStore.get(key)
				return Promise.resolve(v === undefined ? null : { text: () => Promise.resolve(v) })
			},
		},
	}
	return { deps, queue, logStore }
}

function req(method: string, path: string, body?: unknown): Request {
	return new Request(`https://vozka.example${path}`, {
		method,
		...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
	})
}

describe('onboarding + registry CRUD', () => {
	test('registerApp creates the app + its first app_env in one call', async () => {
		const { deps } = makeDeps()

		const response = await handleApi(
			req('POST', '/api/register-app', {
				id: 'acme',
				repoUrl: 'https://github.com/acme/App.git',
				env: 'prod',
				domain: 'acme.example.com',
				triggerRef: 'refs/heads/deploy/prod',
			}),
			deps,
		)
		expect(response.status).toBe(201)

		// App row exists with the NORMALIZED repo URL.
		const app = await deps.db.getApp('acme')
		expect(app?.repo_url).toBe('github.com/acme/App')
		// And its prod env row, with the domain + trigger ref.
		const env = await deps.db.getAppEnv('acme', 'prod')
		expect(env?.domain).toBe('acme.example.com')
		expect(env?.trigger_ref).toBe('refs/heads/deploy/prod')
	})

	test('registerApp rejects a missing field (400) and a duplicate id (409)', async () => {
		const { deps } = makeDeps()
		const missing = await handleApi(req('POST', '/api/register-app', { id: 'x', repoUrl: 'r' }), deps)
		expect(missing.status).toBe(400) // env required

		await handleApi(req('POST', '/api/register-app', { id: 'dup', repoUrl: 'r', env: 'prod' }), deps)
		const dup = await handleApi(req('POST', '/api/register-app', { id: 'dup', repoUrl: 'r', env: 'stage' }), deps)
		expect(dup.status).toBe(409)
	})

	test('apps / app_envs / secrets CRUD round-trips', async () => {
		const { deps } = makeDeps()
		await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)

		// app_env upsert
		const putEnv = await handleApi(req('PUT', '/api/apps/app/envs/prod', { triggerRef: 'refs/heads/deploy/prod' }), deps)
		expect(putEnv.status).toBe(200)

		// secret upsert (a vault REFERENCE, not a value)
		const putSecret = await handleApi(req('PUT', '/api/apps/app/secrets', { name: 'API_KEY', valueRef: 'env:APP_API_KEY' }), deps)
		expect(putSecret.status).toBe(200)
		const secret = (await putSecret.json()) as { valueRef: string }
		expect(secret.valueRef).toBe('env:APP_API_KEY')

		// list secrets
		const listSecrets = await handleApi(req('GET', '/api/apps/app/secrets'), deps)
		const secrets = (await listSecrets.json()) as { items: unknown[] }
		expect(secrets.items).toHaveLength(1)

		// delete secret (all-env layer)
		const delSecret = await handleApi(req('DELETE', '/api/apps/app/secrets/API_KEY'), deps)
		expect(delSecret.status).toBe(200)
		expect(await deps.db.listAppSecrets('app')).toHaveLength(0)

		// delete app cascades its env
		const delApp = await handleApi(req('DELETE', '/api/apps/app'), deps)
		expect(delApp.status).toBe(200)
		expect(await deps.db.getAppEnv('app', 'prod')).toBeNull()
	})

	test('app_vars CRUD round-trips (plaintext value, readable — unlike secrets)', async () => {
		const { deps } = makeDeps()
		await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)

		// var upsert (plaintext config value, e.g. propustka's ACCESS_APPS)
		const putVar = await handleApi(req('PUT', '/api/apps/app/vars', { name: 'PROPUSTKA_TEAM', value: 'https://contember.cloudflareaccess.com' }), deps)
		expect(putVar.status).toBe(200)
		// UNLIKE secrets, the VALUE is returned (vars are non-secret config).
		const v = (await putVar.json()) as { name: string; value: string }
		expect(v.value).toBe('https://contember.cloudflareaccess.com')

		// missing value → 400
		const bad = await handleApi(req('PUT', '/api/apps/app/vars', { name: 'X' }), deps)
		expect(bad.status).toBe(400)

		// list vars
		const listVars = await handleApi(req('GET', '/api/apps/app/vars'), deps)
		const vars = (await listVars.json()) as { items: unknown[] }
		expect(vars.items).toHaveLength(1)

		// delete var (all-env layer)
		const delVar = await handleApi(req('DELETE', '/api/apps/app/vars/PROPUSTKA_TEAM'), deps)
		expect(delVar.status).toBe(200)
		expect(await deps.db.listAppVars('app')).toHaveLength(0)
	})
})

describe('run history API', () => {
	test('lists runs newest-first and filters by app/env', async () => {
		const { deps } = makeDeps()
		await deps.db.createApp({ id: 'a', repoUrl: 'r1' })
		await deps.db.createApp({ id: 'b', repoUrl: 'r2' })
		await deps.db.upsertAppEnv({ appId: 'a', env: 'prod' })
		await deps.db.upsertAppEnv({ appId: 'b', env: 'prod' })
		const r1 = uuidv7()
		await deps.db.createRun({ id: r1, appId: 'a', env: 'prod', ref: 'main', trigger: 'manual' })
		const r2 = uuidv7()
		await deps.db.createRun({ id: r2, appId: 'b', env: 'prod', ref: 'main', trigger: 'webhook' })

		const all = await handleApi(req('GET', '/api/runs'), deps)
		const allBody = (await all.json()) as { items: { id: string }[] }
		expect(allBody.items).toHaveLength(2)
		// Returned in descending id order (UUIDv7 is time-sortable). Within the same millisecond the
		// random bits decide, so assert the query's ORDER BY id DESC rather than a fixed r1/r2 order.
		const ids = allBody.items.map((i) => i.id)
		expect(ids).toEqual([...ids].sort().reverse())
		expect(new Set(ids)).toEqual(new Set([r1, r2]))

		const filtered = await handleApi(req('GET', '/api/runs?app=a'), deps)
		const filteredBody = (await filtered.json()) as { items: { id: string }[] }
		expect(filteredBody.items).toHaveLength(1)
		expect(filteredBody.items[0]?.id).toBe(r1)
	})

	test('getRunLog reads + parses the NDJSON log from R2', async () => {
		const { deps, logStore } = makeDeps()
		await deps.db.createApp({ id: 'a', repoUrl: 'r' })
		await deps.db.upsertAppEnv({ appId: 'a', env: 'prod' })
		const runId = uuidv7()
		await deps.db.createRun({ id: runId, appId: 'a', env: 'prod', ref: 'main', trigger: 'manual' })
		await deps.db.markRunStarted(runId, logsKey(runId))
		// Stage two log lines in the fake R2 under the run's log key.
		logStore.set(
			logsKey(runId),
			[JSON.stringify({ ts: 1, stream: 'meta', text: 'Cloning' }), JSON.stringify({ ts: 2, stream: 'stdout', text: 'done' })].join('\n'),
		)

		const response = await handleApi(req('GET', `/api/runs/${runId}/log`), deps)
		expect(response.status).toBe(200)
		const body = (await response.json()) as { lines: { text: string }[] }
		expect(body.lines).toHaveLength(2)
		expect(body.lines[1]?.text).toBe('done')

		// tail with a cursor returns only the new lines + a done flag once terminal.
		const tail = await handleApi(req('GET', `/api/runs/${runId}/tail?after=1`), deps)
		const tailBody = (await tail.json()) as { lines: unknown[]; cursor: number; done: boolean }
		expect(tailBody.lines).toHaveLength(1)
		expect(tailBody.cursor).toBe(2)
	})

	test('getRun 404s an unknown id', async () => {
		const { deps } = makeDeps()
		const response = await handleApi(req('GET', '/api/runs/nope'), deps)
		expect(response.status).toBe(404)
	})
})
