import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { type Authenticator, fakeAuthenticator } from '../iam'
import type { DeployJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'
import { allowAllIam } from './helpers/iam'

// ACL enforcement at the API boundary, exercised with the dev authenticator (no propustka, no IAM
// Worker). Each persona carries a permissions array that `can()` checks against the requested action +
// scope — so we can assert both an allowed call and a forbidden (403) call per action.

/** A dev authenticator over a single default persona holding exactly `actions` globally. */
function personaIam(email: string, actions: string[]): Authenticator {
	return fakeAuthenticator({
		personas: {
			[email]: { id: `p-${email}`, label: email, type: 'user', permissions: actions.map((action) => ({ action, scope: null, source: 'grant' })) },
		},
		defaultEmail: email,
	})
}

/** In-memory deps for the router: real Db over sqlite, a recording queue, an empty R2 reader. */
function makeDeps(iam: Authenticator): { deps: ApiDeps; queue: DeployJobMessage[]; sqlite: ReturnType<typeof createHarness>['sqlite'] } {
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

describe('ACL enforcement (dev authenticator)', () => {
	test('an allow-all caller can create an app (app.manage)', async () => {
		const { deps } = makeDeps(allowAllIam())
		const response = await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'github.com/acme/app' }), deps)
		expect(response.status).toBe(201)
	})

	test('a caller without app.manage cannot create an app', async () => {
		const { deps } = makeDeps(personaIam('ro@vozka.test', ['deploy.read']))
		const response = await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)
		expect(response.status).toBe(403)
	})

	test('a persona with only deploy.read can read runs but cannot trigger a deploy', async () => {
		// This persona holds deploy.read globally only.
		const { deps } = makeDeps(personaIam('r@vozka.test', ['deploy.read']))
		// Seed an app + env so trigger gets past lookups (it should still 403 on the can-check first).
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.db.upsertAppEnv({ appId: 'app', env: 'prod' })

		const read = await handleApi(req('GET', '/api/runs'), deps)
		expect(read.status).toBe(200)

		const trigger = await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), deps)
		expect(trigger.status).toBe(403)
	})

	test('a persona with deploy.* can trigger a deploy (enqueues + creates the run)', async () => {
		const { deps, queue } = makeDeps(personaIam('op@vozka.test', ['deploy.*']))
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app', defaultBranch: 'main' })
		await deps.db.upsertAppEnv({ appId: 'app', env: 'prod' })

		const response = await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), deps)
		expect(response.status).toBe(201)
		const run = (await response.json()) as { id: string; ref: string; trigger: string }
		expect(run.trigger).toBe('manual')
		expect(run.ref).toBe('refs/heads/main') // defaulted from the app's default branch
		expect(queue).toEqual([{ runId: run.id }])
	})

	test('an unknown persona is 403 — no resolvable identity', async () => {
		const iam = fakeAuthenticator({ personas: {}, defaultEmail: 'ghost@vozka.test' })
		const { deps } = makeDeps(iam)
		const response = await handleApi(req('GET', '/api/apps'), deps)
		expect(response.status).toBe(403)
	})

	test('unknown route → 404, unknown method → 405', async () => {
		const { deps } = makeDeps(allowAllIam())
		expect((await handleApi(req('GET', '/api/nope'), deps)).status).toBe(404)
		expect((await handleApi(req('DELETE', '/api/apps'), deps)).status).toBe(405)
	})
})
