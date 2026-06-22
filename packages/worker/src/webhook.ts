// The GitHub webhook handler — the ONE unauthenticated route. It is HMAC-gated instead: the
// RepoSource verifies the `X-Hub-Signature-256` over the raw body before anything touches D1. On a
// verified push it maps repo+ref → (app, env) via the registry, creates a `pending` run, and enqueues
// the deploy. A push that no env subscribes to is a 204 no-op (acknowledged, nothing deployed).
//
// Decoupled from the Worker (takes a Db + RepoSource + queue) so it's unit-testable with FakeRepoSource
// and an in-memory queue — no GitHub, no Cloudflare.

import { type Db } from './db'
import { uuidv7 } from './db'
import { error, json } from './http'
import { normalizeRepoUrl, type RepoSource } from './repo-source'
import type { DeployJobMessage } from './run-lifecycle'

export interface WebhookDeps {
	db: Db
	repoSource: RepoSource
	queue: { send(message: DeployJobMessage): Promise<unknown> }
}

/**
 * Handle `POST /webhooks/github`. Verify the HMAC, decode the push, and for every (app, env) whose
 * `trigger_ref` matches the pushed ref, create + enqueue a run. Returns:
 *   - 401 when the signature is missing/invalid (HMAC gate — the only auth on this route),
 *   - 204 when verified but no env subscribes to the ref (acknowledged no-op),
 *   - 200 with the created run ids when one or more deploys were triggered.
 */
export async function handleWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
	const push = await deps.repoSource.verifyWebhook(request)
	if (push === null) {
		// Either a bad signature or an undecodable body — both are 401 on this HMAC-gated route (we do
		// not distinguish, to avoid leaking which check failed).
		return error(401, 'invalid webhook signature')
	}

	const normalized = normalizeRepoUrl(push.repoUrl)
	const apps = await deps.db.getAppsByRepoUrl(normalized)
	if (apps.length === 0) {
		// No app registered for this repo — acknowledge so GitHub doesn't retry.
		return new Response(null, { status: 204 })
	}

	const triggered: string[] = []
	for (const app of apps) {
		const appEnv = await deps.db.getAppEnvByTriggerRef(app.id, push.ref)
		if (appEnv === null) {
			continue // this app has no env subscribed to the pushed ref
		}
		const run = await deps.db.createRun({
			id: uuidv7(),
			appId: app.id,
			env: appEnv.env,
			ref: push.ref,
			commitSha: push.commitSha,
			trigger: 'webhook',
		})
		await deps.queue.send({ runId: run.id })
		triggered.push(run.id)
	}

	if (triggered.length === 0) {
		return new Response(null, { status: 204 })
	}
	return json({ triggered })
}
