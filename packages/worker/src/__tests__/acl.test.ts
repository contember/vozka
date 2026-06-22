import { FakeIamClient } from '@propustka/client'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import type { DeployJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'

// ACL enforcement at the API boundary, exercised with FakeIamClient (no Access, no IAM Worker). The
// fake's SIMPLE mode allows everything EXCEPT a `deny` list, and PERSONA mode backs `can()` with real
// `permits` semantics — so we can assert both an allowed call and a forbidden (403) call per action.

/** In-memory deps for the router: real Db over sqlite, a recording queue, an empty R2 reader. */
function makeDeps(iam: FakeIamClient): { deps: ApiDeps; queue: DeployJobMessage[]; sqlite: ReturnType<typeof createHarness>['sqlite'] } {
	const { db, sqlite } = createHarness()
	const queue: DeployJobMessage[] = []
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
	}
	return { deps, queue, sqlite }
}

function req(method: string, path: string, body?: unknown): Request {
	return new Request(`https://vozka.example${path}`, {
		method,
		...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
	})
}

describe('ACL enforcement (FakeIamClient)', () => {
	test('an allow-all caller can create an app (app.manage)', async () => {
		const { deps } = makeDeps(new FakeIamClient())
		const response = await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'github.com/acme/app' }), deps)
		expect(response.status).toBe(201)
	})

	test('a caller denied app.manage cannot create an app', async () => {
		const { deps } = makeDeps(new FakeIamClient({ deny: ['app.manage'] }))
		const response = await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)
		expect(response.status).toBe(403)
	})

	test('a persona with only deploy.read can read runs but cannot trigger a deploy', async () => {
		// Persona mode: real permits semantics. This persona holds deploy.read globally only.
		const iam = new FakeIamClient({
			personas: {
				'r@vozka.test': { id: 'p-r', label: 'r@vozka.test', type: 'user', permissions: [{ action: 'deploy.read', scope: null, source: 'grant' }] },
			},
			defaultPersona: 'r@vozka.test',
		})
		const { deps } = makeDeps(iam)
		// Seed an app + env so trigger gets past lookups (it should still 403 on the can-check first).
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.db.upsertAppEnv({ appId: 'app', env: 'prod' })

		const read = await handleApi(req('GET', '/api/runs'), deps)
		expect(read.status).toBe(200)

		const trigger = await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), deps)
		expect(trigger.status).toBe(403)
	})

	test('a persona with deploy.* can trigger a deploy (enqueues + creates the run)', async () => {
		const iam = new FakeIamClient({
			personas: {
				'op@vozka.test': { id: 'p-op', label: 'op@vozka.test', type: 'user', permissions: [{ action: 'deploy.*', scope: null, source: 'grant' }] },
			},
			defaultPersona: 'op@vozka.test',
		})
		const { deps, queue } = makeDeps(iam)
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app', defaultBranch: 'main' })
		await deps.db.upsertAppEnv({ appId: 'app', env: 'prod' })

		const response = await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), deps)
		expect(response.status).toBe(201)
		const run = (await response.json()) as { id: string; ref: string; trigger: string }
		expect(run.trigger).toBe('manual')
		expect(run.ref).toBe('refs/heads/main') // defaulted from the app's default branch
		expect(queue).toEqual([{ runId: run.id }])
	})

	test('an unknown persona (no grant) is 403 — authenticated but unrecognised', async () => {
		const iam = new FakeIamClient({ personas: {}, defaultPersona: 'ghost@vozka.test' })
		const { deps } = makeDeps(iam)
		const response = await handleApi(req('GET', '/api/apps'), deps)
		expect(response.status).toBe(403)
	})

	test('unknown route → 404, unknown method → 405', async () => {
		const { deps } = makeDeps(new FakeIamClient())
		expect((await handleApi(req('GET', '/api/nope'), deps)).status).toBe(404)
		expect((await handleApi(req('DELETE', '/api/apps'), deps)).status).toBe(405)
	})
})
