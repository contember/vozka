import { describe, expect, test } from 'bun:test'
import { feedUrlFor, type FetchFn, parseLatestEntry, pollPublicRepos } from '../repo-poll'
import type { DeployJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'

// Public-repo polling: the pull-based deploy trigger for apps with no GitHub App install. These tests
// cover the pure feed-URL selection + Atom parse, and the full poll loop over the in-memory harness
// with a fake `fetch` (conditional GET → new sha / 304 / unchanged / error). No GitHub, no Cloudflare.

const REPO = 'https://github.com/acme/app.git'

// ── feedUrlFor (ref → GitHub Atom feed) ───────────────────────────────────────

describe('feedUrlFor', () => {
	test('a branch ref maps to its commits feed', () => {
		expect(feedUrlFor(REPO, 'refs/heads/main')).toBe('https://github.com/acme/app/commits/main.atom')
	})

	test('a branch with a slash keeps the slash in the feed path', () => {
		expect(feedUrlFor(REPO, 'refs/heads/deploy/prod')).toBe('https://github.com/acme/app/commits/deploy/prod.atom')
	})

	test('a tag ref maps to the repo tags feed', () => {
		expect(feedUrlFor(REPO, 'refs/tags/v1.2.3')).toBe('https://github.com/acme/app/tags.atom')
	})

	test('a non-pollable ref returns null', () => {
		expect(feedUrlFor(REPO, 'refs/pull/42/head')).toBeNull()
		expect(feedUrlFor(REPO, 'main')).toBeNull()
		expect(feedUrlFor(REPO, 'refs/heads/')).toBeNull()
	})

	test('the repo URL is normalized (scp / .git / host case all resolve the same slug)', () => {
		const expected = 'https://github.com/acme/app/commits/main.atom'
		expect(feedUrlFor('git@github.com:acme/app.git', 'refs/heads/main')).toBe(expected)
		expect(feedUrlFor('https://GitHub.com/acme/app', 'refs/heads/main')).toBe(expected)
	})
})

// ── parseLatestEntry (newest Atom entry → 40-hex sha) ─────────────────────────

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** A realistic GitHub commits-feed snippet whose newest entry carries `sha`. */
function commitsFeed(sha: string, olderSha = SHA_B): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<id>tag:github.com,2008:/acme/app/commits/main</id>
	<title>Recent Commits to app:main</title>
	<entry>
		<id>tag:github.com,2008:Grit::Commit/${sha}</id>
		<link type="text/html" rel="alternate" href="https://github.com/acme/app/commit/${sha}"/>
		<title>newest commit</title>
	</entry>
	<entry>
		<id>tag:github.com,2008:Grit::Commit/${olderSha}</id>
		<link type="text/html" rel="alternate" href="https://github.com/acme/app/commit/${olderSha}"/>
		<title>older commit</title>
	</entry>
</feed>`
}

describe('parseLatestEntry', () => {
	test('extracts the newest entry sha from a realistic commits feed', () => {
		expect(parseLatestEntry(commitsFeed(SHA_A))).toEqual({ sha: SHA_A })
	})

	test('reads the FIRST entry (newest), not a later one', () => {
		const result = parseLatestEntry(commitsFeed(SHA_A, SHA_B))
		expect(result?.sha).toBe(SHA_A)
	})

	test('lowercases an upper-case sha', () => {
		const upper = commitsFeed(SHA_A.toUpperCase())
		expect(parseLatestEntry(upper)).toEqual({ sha: SHA_A })
	})

	test('returns null for an empty / entry-less / malformed feed', () => {
		expect(parseLatestEntry('')).toBeNull()
		expect(parseLatestEntry('<feed></feed>')).toBeNull()
		expect(parseLatestEntry('<entry><id>no sha here</id></entry>')).toBeNull()
		expect(parseLatestEntry('not xml at all')).toBeNull()
	})
})

// ── pollPublicRepos (the loop, over the harness + a fake fetch) ────────────────

type FakeResponse = { status: number; ok: boolean; etag?: string; body?: string }

/** A `fetch` that answers per-URL from a script, recording the requests (with their headers) it saw. */
function fakeFetch(routes: Record<string, FakeResponse | (() => FakeResponse | Promise<never>)>) {
	const calls: Array<{ url: string; ifNoneMatch: string | null; userAgent: string | null }> = []
	const fn: FetchFn = (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		const headers = new Headers(init?.headers)
		calls.push({ url, ifNoneMatch: headers.get('if-none-match'), userAgent: headers.get('user-agent') })
		const route = routes[url]
		if (route === undefined) {
			return Promise.reject(new Error(`unexpected fetch: ${url}`))
		}
		const resolved = typeof route === 'function' ? route() : route
		if (resolved instanceof Promise) {
			return resolved
		}
		const responseHeaders = new Headers()
		if (resolved.etag !== undefined) {
			responseHeaders.set('etag', resolved.etag)
		}
		const response = new Response(resolved.body ?? '', { status: resolved.status, headers: responseHeaders })
		// `Response` derives `ok` from the status; for a 304 (which Response treats as non-ok) the route's
		// explicit `ok`/`status` is what the poller reads, so a Response with status 304 is faithful.
		return Promise.resolve(response)
	}
	return { fetch: fn, calls }
}

/** A tiny in-memory queue capturing enqueued messages (mirrors webhook.test.ts). */
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

const NOW = 1_700_000_000

describe('pollPublicRepos', () => {
	test('200 with a new sha creates a poll run, enqueues it, and stores the etag + last_seen_sha', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO }) // public: no installation
		await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: 'refs/heads/main' })
		const queue = makeQueue()
		const { fetch, calls } = fakeFetch({
			'https://github.com/acme/app/commits/main.atom': { status: 200, ok: true, etag: '"etag-1"', body: commitsFeed(SHA_A) },
		})

		const summary = await pollPublicRepos({ db, fetch, queue, now: () => NOW })

		expect(summary).toEqual({ polled: 1, triggered: 1, unchanged: 0, errored: 0, skipped: 0 })
		// First poll has no prior etag → no If-None-Match; the user-agent is sent.
		expect(calls).toHaveLength(1)
		expect(calls[0]?.ifNoneMatch).toBeNull()
		expect(calls[0]?.userAgent).toBe('vozka')

		// A pending poll run for the resolved commit was created + enqueued.
		const runs = await db.listRuns({ limit: 10 })
		expect(runs).toHaveLength(1)
		expect(runs[0]?.trigger).toBe('poll')
		expect(runs[0]?.status).toBe('pending')
		expect(runs[0]?.env).toBe('prod')
		expect(runs[0]?.ref).toBe('refs/heads/main')
		expect(runs[0]?.commit_sha).toBe(SHA_A)
		expect(queue.sent).toEqual([{ runId: runs[0]!.id }])

		// Poll state recorded the etag + last-seen sha + timestamp, no error.
		const state = await db.getRepoPollState('app', 'prod')
		expect(state?.etag).toBe('"etag-1"')
		expect(state?.last_seen_sha).toBe(SHA_A)
		expect(state?.last_polled_at).toBe(NOW)
		expect(state?.last_error).toBeNull()
	})

	test('a stored etag is sent as If-None-Match; a 304 creates no run and only bumps last_polled_at', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: 'refs/heads/main' })
		// Seed prior state as if a previous poll saw SHA_A with etag-1.
		await db.upsertRepoPollState({ appId: 'app', env: 'prod', etag: '"etag-1"', lastSeenSha: SHA_A, lastPolledAt: NOW - 300 })
		const queue = makeQueue()
		const { fetch, calls } = fakeFetch({
			'https://github.com/acme/app/commits/main.atom': { status: 304, ok: false },
		})

		const summary = await pollPublicRepos({ db, fetch, queue, now: () => NOW })

		expect(summary).toEqual({ polled: 1, triggered: 0, unchanged: 1, errored: 0, skipped: 0 })
		expect(calls[0]?.ifNoneMatch).toBe('"etag-1"')
		expect(queue.sent).toHaveLength(0)
		expect(await db.listRuns({ limit: 10 })).toHaveLength(0)

		// last_polled_at advanced; etag + last_seen_sha preserved across the 304.
		const state = await db.getRepoPollState('app', 'prod')
		expect(state?.last_polled_at).toBe(NOW)
		expect(state?.etag).toBe('"etag-1"')
		expect(state?.last_seen_sha).toBe(SHA_A)
		expect(state?.last_error).toBeNull()
	})

	test('200 whose newest sha equals last_seen_sha creates no run (counts as unchanged)', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: 'refs/heads/main' })
		await db.upsertRepoPollState({ appId: 'app', env: 'prod', etag: '"old"', lastSeenSha: SHA_A, lastPolledAt: NOW - 300 })
		const queue = makeQueue()
		const { fetch } = fakeFetch({
			'https://github.com/acme/app/commits/main.atom': { status: 200, ok: true, etag: '"new"', body: commitsFeed(SHA_A) },
		})

		const summary = await pollPublicRepos({ db, fetch, queue, now: () => NOW })

		expect(summary).toEqual({ polled: 1, triggered: 0, unchanged: 1, errored: 0, skipped: 0 })
		expect(queue.sent).toHaveLength(0)
		expect(await db.listRuns({ limit: 10 })).toHaveLength(0)
		// The etag is refreshed even when the head is unchanged.
		const state = await db.getRepoPollState('app', 'prod')
		expect(state?.etag).toBe('"new"')
		expect(state?.last_seen_sha).toBe(SHA_A)
	})

	test('a private app (installation set) is NOT polled', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO, githubInstallationId: 42 })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: 'refs/heads/main' })
		const queue = makeQueue()
		const { fetch, calls } = fakeFetch({})

		const summary = await pollPublicRepos({ db, fetch, queue, now: () => NOW })

		expect(summary).toEqual({ polled: 0, triggered: 0, unchanged: 0, errored: 0, skipped: 0 })
		expect(calls).toHaveLength(0)
		expect(await db.listRuns({ limit: 10 })).toHaveLength(0)
	})

	test('a manual-only env (null trigger_ref) is NOT polled', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: null })
		const queue = makeQueue()
		const { fetch, calls } = fakeFetch({})

		const summary = await pollPublicRepos({ db, fetch, queue, now: () => NOW })

		expect(summary).toEqual({ polled: 0, triggered: 0, unchanged: 0, errored: 0, skipped: 0 })
		expect(calls).toHaveLength(0)
	})

	test('one repo erroring records a last_error and does NOT stop the others', async () => {
		const { db } = createHarness()
		// Two public apps; the first errors (network throw), the second succeeds.
		await db.createApp({ id: 'bad', repoUrl: 'https://github.com/acme/bad.git' })
		await db.upsertAppEnv({ appId: 'bad', env: 'prod', triggerRef: 'refs/heads/main' })
		await db.createApp({ id: 'good', repoUrl: 'https://github.com/acme/good.git' })
		await db.upsertAppEnv({ appId: 'good', env: 'prod', triggerRef: 'refs/heads/main' })
		const queue = makeQueue()
		const { fetch } = fakeFetch({
			'https://github.com/acme/bad/commits/main.atom': () => Promise.reject(new Error('boom')),
			'https://github.com/acme/good/commits/main.atom': { status: 200, ok: true, etag: '"e"', body: commitsFeed(SHA_A) },
		})

		const summary = await pollPublicRepos({ db, fetch, queue, now: () => NOW })

		expect(summary).toEqual({ polled: 2, triggered: 1, unchanged: 0, errored: 1, skipped: 0 })
		// The bad repo recorded a short error and was not enqueued.
		const badState = await db.getRepoPollState('bad', 'prod')
		expect(badState?.last_error).toBe('boom')
		expect(badState?.last_polled_at).toBe(NOW)
		// The good repo still triggered a run despite the earlier failure.
		const runs = await db.listRuns({ limit: 10 })
		expect(runs).toHaveLength(1)
		expect(runs[0]?.app_id).toBe('good')
		expect(queue.sent).toHaveLength(1)
	})

	test('a non-2xx-non-304 response records a short last_error (status only, no body)', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: 'refs/heads/main' })
		const queue = makeQueue()
		const { fetch } = fakeFetch({
			'https://github.com/acme/app/commits/main.atom': { status: 404, ok: false, body: 'a very long not-found body that must never be stored' },
		})

		const summary = await pollPublicRepos({ db, fetch, queue, now: () => NOW })

		expect(summary).toEqual({ polled: 1, triggered: 0, unchanged: 0, errored: 1, skipped: 0 })
		const state = await db.getRepoPollState('app', 'prod')
		expect(state?.last_error).toBe('feed HTTP 404')
		expect(await db.listRuns({ limit: 10 })).toHaveLength(0)
	})

	test('an eligible env whose ref is not pollable is skipped (counted skipped, not polled)', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO })
		// A subscribed but non-pollable ref (e.g. a PR ref): eligible by the query, not pollable by feed.
		await db.upsertAppEnv({ appId: 'app', env: 'prod', triggerRef: 'refs/pull/9/head' })
		const queue = makeQueue()
		const { fetch, calls } = fakeFetch({})

		const summary = await pollPublicRepos({ db, fetch, queue, now: () => NOW })

		expect(summary).toEqual({ polled: 0, triggered: 0, unchanged: 0, errored: 0, skipped: 1 })
		expect(calls).toHaveLength(0)
	})
})

// ── Db poll methods ───────────────────────────────────────────────────────────

describe('Db repo-poll methods', () => {
	test('getPollEligibleEnvs returns only public apps with a trigger_ref, joined', async () => {
		const { db } = createHarness()
		// Eligible: public + trigger_ref.
		await db.createApp({ id: 'pub', repoUrl: REPO })
		await db.upsertAppEnv({ appId: 'pub', env: 'prod', triggerRef: 'refs/heads/main' })
		// Excluded: has an installation (private).
		await db.createApp({ id: 'priv', repoUrl: 'https://github.com/acme/priv.git', githubInstallationId: 1 })
		await db.upsertAppEnv({ appId: 'priv', env: 'prod', triggerRef: 'refs/heads/main' })
		// Excluded: public but manual-only (null trigger_ref).
		await db.createApp({ id: 'manual', repoUrl: 'https://github.com/acme/manual.git' })
		await db.upsertAppEnv({ appId: 'manual', env: 'prod', triggerRef: null })

		const eligible = await db.getPollEligibleEnvs()
		expect(eligible).toHaveLength(1)
		expect(eligible[0]?.app.id).toBe('pub')
		expect(eligible[0]?.app.repo_url).toBe(REPO)
		expect(eligible[0]?.appEnv.env).toBe('prod')
		expect(eligible[0]?.appEnv.trigger_ref).toBe('refs/heads/main')
	})

	test('upsertRepoPollState inserts then overwrites on (app_id, env)', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO })

		const inserted = await db.upsertRepoPollState({ appId: 'app', env: 'prod', etag: '"e1"', lastSeenSha: SHA_A, lastPolledAt: 100 })
		expect(inserted.etag).toBe('"e1"')
		expect(inserted.last_seen_sha).toBe(SHA_A)
		expect(inserted.last_polled_at).toBe(100)

		const updated = await db.upsertRepoPollState({ appId: 'app', env: 'prod', etag: '"e2"', lastSeenSha: SHA_B, lastPolledAt: 200, lastError: 'oops' })
		expect(updated.etag).toBe('"e2"')
		expect(updated.last_seen_sha).toBe(SHA_B)
		expect(updated.last_polled_at).toBe(200)
		expect(updated.last_error).toBe('oops')

		// Still a single row for (app, env).
		const state = await db.getRepoPollState('app', 'prod')
		expect(state?.etag).toBe('"e2"')
	})

	test('getRepoPollState returns null when there is no state', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: REPO })
		expect(await db.getRepoPollState('app', 'prod')).toBeNull()
	})
})
