import { describe, expect, test } from 'bun:test'
import { FakeRepoSource, normalizeRepoUrl } from '../repo-source'
import type { DeployJobMessage } from '../run-lifecycle'
import { handleWebhook } from '../webhook'
import { createHarness, pushWebhookRequest, signWebhook } from './helpers/harness'

// The webhook is the one unauthenticated route, HMAC-gated. These tests exercise: (1) signature
// verification (good/bad), (2) repo+ref → (app, env) mapping driving run creation + enqueue, (3) the
// verified-but-unsubscribed no-op. FakeRepoSource runs the REAL HMAC verify, so the signature path is
// genuine — no GitHub, no Cloudflare.

const SECRET = 'webhook-test-secret'

/** A tiny in-memory queue capturing enqueued messages. */
function makeQueue(): { sent: DeployJobMessage[]; send(message: DeployJobMessage): Promise<void> } {
	const sent: DeployJobMessage[] = []
	return {
		sent,
		send(m: DeployJobMessage): Promise<void> {
			sent.push(m)
			return Promise.resolve()
		},
	}
}

/**
 * Seed an account + app + app_env with a trigger ref pointing at `prod`. Stores the NORMALIZED repo
 * URL (the handlers normalize on write; here we seed the Db directly, so we normalize explicitly).
 */
async function seedRegistry(db: ReturnType<typeof createHarness>['db'], cloneUrl: string): Promise<void> {
	await db.createApp({ id: 'app', repoUrl: normalizeRepoUrl(cloneUrl) })
	await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: 'refs/heads/deploy/prod' })
}

describe('handleWebhook (HMAC + ref→env)', () => {
	test('a valid signature on a subscribed ref creates a pending run + enqueues it', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl)
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, after: 'sha-1', secret: SECRET })

		const response = await handleWebhook(request, { db, repoSource: new FakeRepoSource({ webhookSecret: SECRET }), queue })

		expect(response.status).toBe(200)
		const body = (await response.json()) as { triggered: string[] }
		expect(body.triggered).toHaveLength(1)

		// The run row exists, pending, trigger=webhook, with the pushed commit.
		const run = await db.getRun(body.triggered[0]!)
		expect(run).not.toBeNull()
		expect(run?.status).toBe('pending')
		expect(run?.trigger).toBe('webhook')
		expect(run?.env).toBe('prod')
		expect(run?.commit_sha).toBe('sha-1')
		// And it was enqueued.
		expect(queue.sent).toEqual([{ runId: body.triggered[0]! }])
	})

	test('a bad signature is rejected (401) and creates no run', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl)
		const queue = makeQueue()
		const request = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl,
			secret: SECRET,
			signatureOverride: 'sha256=deadbeef',
		})

		const response = await handleWebhook(request, { db, repoSource: new FakeRepoSource({ webhookSecret: SECRET }), queue })

		expect(response.status).toBe(401)
		expect(queue.sent).toHaveLength(0)
		expect(await db.listRuns({ limit: 10 })).toHaveLength(0)
	})

	test('a signature for the WRONG secret is rejected (401)', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl)
		const queue = makeQueue()
		// Sign with a different secret than the source verifies against.
		const signatureOverride = await signWebhook(JSON.stringify({ ref: 'x', repository: { clone_url: cloneUrl } }), 'other-secret')
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, secret: SECRET, signatureOverride })

		const response = await handleWebhook(request, { db, repoSource: new FakeRepoSource({ webhookSecret: SECRET }), queue })
		expect(response.status).toBe(401)
	})

	test('a verified push on an UNSUBSCRIBED ref is a 204 no-op (no run, no enqueue)', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl) // only refs/heads/deploy/prod is subscribed
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/main', cloneUrl, secret: SECRET })

		const response = await handleWebhook(request, { db, repoSource: new FakeRepoSource({ webhookSecret: SECRET }), queue })

		expect(response.status).toBe(204)
		expect(queue.sent).toHaveLength(0)
		expect(await db.listRuns({ limit: 10 })).toHaveLength(0)
	})

	test('a push for an UNREGISTERED repo is a 204 no-op', async () => {
		const { db } = createHarness()
		await seedRegistry(db, 'https://github.com/acme/app.git')
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl: 'https://github.com/other/repo.git', secret: SECRET })

		const response = await handleWebhook(request, { db, repoSource: new FakeRepoSource({ webhookSecret: SECRET }), queue })
		expect(response.status).toBe(204)
		expect(queue.sent).toHaveLength(0)
	})

	test('repo URL matching is normalized (registered https vs pushed .git/scp form both match)', async () => {
		const { db } = createHarness()
		// Registered WITHOUT .git; pushed WITH .git and mixed case host — must still match.
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/App' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: 'refs/heads/deploy/prod' })
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl: 'https://GitHub.com/acme/App.git', secret: SECRET })

		const response = await handleWebhook(request, { db, repoSource: new FakeRepoSource({ webhookSecret: SECRET }), queue })
		expect(response.status).toBe(200)
		expect(queue.sent).toHaveLength(1)
	})
})
