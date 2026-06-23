// Public-repo POLLING — the pull-based deploy trigger for apps with no GitHub App installation.
//
// A private app (a GitHub App install) gets a push webhook (src/webhook.ts). A PUBLIC app has no
// installation and so no webhook, so vozka instead POLLS the repo's commits/tags Atom feed on a cron
// (wired in src/index.ts `scheduled`). For each poll-eligible (app, env) we conditional-GET the feed
// (If-None-Match against the stored ETag), and when the subscribed ref's head sha changes we create a
// `poll`-triggered run and enqueue it — the same outcome as a verified webhook push.
//
// Decoupled from the Worker (takes a Db + fetch + queue + clock) so it's unit-testable with the
// in-memory harness and a fake `fetch` — no GitHub, no Cloudflare, no cron. This is the post-v1 seam
// the repo-source header describes; it is standalone (no webhook HMAC applies to a public feed) rather
// than a `RepoSource` implementation.

import { type Db, uuidv7 } from './db'
import { normalizeRepoUrl } from './repo-source'
import type { DeployJobMessage } from './run-lifecycle'

/**
 * The slice of `fetch` the poller uses — just the call signature. Narrower than `typeof fetch` (which
 * also carries `preconnect`), so the real global is assignable AND a test fake needs no `as` cast.
 */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Everything the poller needs, injected so the core is pure + testable. */
export interface PollDeps {
	db: Db
	/** `fetch` for the conditional GET of the Atom feed. The real global, or a fake in tests. */
	fetch: FetchFn
	/** The deploy queue producer — same message a webhook trigger enqueues. */
	queue: { send(message: DeployJobMessage): Promise<unknown> }
	/** Monotonic-ish wall clock in unix SECONDS for `last_polled_at` (matches the SQL `unixepoch()`). */
	now: () => number
}

/** A small batch summary for the scheduled-handler log + tests (no secrets, just counts). */
export interface PollSummary {
	/** Eligible (app, env) pairs we attempted (skipped non-pollable refs are NOT counted). */
	polled: number
	/** New head sha → a run was created + enqueued. */
	triggered: number
	/** Feed unchanged (304, or 200 whose newest sha equals the last-seen sha). */
	unchanged: number
	/** A poll failed (network / non-2xx-non-304 / unparseable) — recorded as last_error, batch continued. */
	errored: number
	/** Eligible pairs whose ref isn't pollable (not refs/heads/* or refs/tags/*) — skipped, not polled. */
	skipped: number
}

/**
 * Map a subscribed git ref to the GitHub Atom feed that reflects its head:
 *   - `refs/heads/<branch>` → the branch commits feed `.../commits/<branch>.atom` (branch may contain `/`).
 *   - `refs/tags/<tag>`     → the repo tags feed `.../tags.atom` (no per-tag commits feed exists).
 *   - anything else         → null (not pollable; the caller skips it).
 * `<owner>/<repo>` is derived from the repo URL with the SAME normalization as the webhook path
 * (`normalizeRepoUrl` strips scheme/.git/host-case), so a registered URL in any form resolves the same.
 * Pure + exported for unit tests.
 */
export function feedUrlFor(repoUrl: string, triggerRef: string): string | null {
	const slug = repoSlug(repoUrl)
	if (slug === null) {
		return null
	}
	if (triggerRef.startsWith('refs/heads/')) {
		const branch = triggerRef.slice('refs/heads/'.length)
		if (branch === '') {
			return null
		}
		// Keep slashes in the branch intact (e.g. `deploy/prod` → `commits/deploy/prod.atom`).
		return `https://github.com/${slug}/commits/${branch}.atom`
	}
	if (triggerRef.startsWith('refs/tags/')) {
		const tag = triggerRef.slice('refs/tags/'.length)
		if (tag === '') {
			return null
		}
		return `https://github.com/${slug}/tags.atom`
	}
	return null
}

/** `owner/repo` from a repo URL via the shared normalizer (`host/owner/repo` → strip the host). null if shapeless. */
function repoSlug(repoUrl: string): string | null {
	const normalized = normalizeRepoUrl(repoUrl) // host/owner/repo (host lowercased, .git/trailing-slash dropped)
	const firstSlash = normalized.indexOf('/')
	if (firstSlash === -1) {
		return null
	}
	const slug = normalized.slice(firstSlash + 1)
	// Require at least an owner/repo shape; reject empties.
	if (slug === '' || !slug.includes('/')) {
		return null
	}
	return slug
}

/** The newest feed entry's identifying commit sha — what a poll compares against the last-seen sha. */
export interface LatestEntry {
	/** The 40-hex commit sha of the newest entry. */
	sha: string
}

/**
 * Parse the newest entry's 40-hex commit sha out of a GitHub commits Atom feed. GitHub's entry `<id>`
 * is `tag:github.com,2008:Grit::Commit/<40-hex-sha>` and there's a `<link href=".../commits/<sha>"/>`;
 * we pull the FIRST 40-hex run from the FIRST `<entry>`. Defensive by design — a malformed / empty feed
 * returns null and never throws. A small regex parse (no XML dependency — matches the repo's zero-dep style).
 */
export function parseLatestEntry(atomXml: string): LatestEntry | null {
	// Isolate the first <entry> so we read the NEWEST entry's sha, not some later one (feeds are newest-first).
	const entryMatch = /<entry[\s>][\s\S]*?<\/entry>/i.exec(atomXml)
	if (entryMatch === null) {
		return null
	}
	const entry = entryMatch[0]
	// A 40-hex run identifies the commit (from the <id> Grit::Commit/<sha> or the commits/<sha> link).
	const shaMatch = /\b[0-9a-f]{40}\b/i.exec(entry)
	if (shaMatch === null) {
		return null
	}
	return { sha: shaMatch[0].toLowerCase() }
}

/**
 * Poll every poll-eligible (app, env) once. For each: resolve the feed for its subscribed ref;
 * conditional-GET it (If-None-Match when an ETag is stored); on 304 just touch `last_polled_at`; on
 * 200 parse the newest sha and, when it differs from the last-seen sha, create a `poll` run + enqueue
 * it, then store the new ETag + sha. Any failure is recorded as a SHORT `last_error` and the batch
 * continues — one repo's failure never aborts the rest. Returns a counts-only summary.
 */
export async function pollPublicRepos(deps: PollDeps): Promise<PollSummary> {
	const summary: PollSummary = { polled: 0, triggered: 0, unchanged: 0, errored: 0, skipped: 0 }
	const eligible = await deps.db.getPollEligibleEnvs()

	for (const { app, appEnv } of eligible) {
		const triggerRef = appEnv.trigger_ref
		if (triggerRef === null) {
			continue // defensive: the query already filters these out
		}
		const feedUrl = feedUrlFor(app.repo_url, triggerRef)
		if (feedUrl === null) {
			summary.skipped++
			continue
		}

		summary.polled++
		const polledAt = deps.now()
		const prior = await deps.db.getRepoPollState(app.id, appEnv.env)

		try {
			const headers: Record<string, string> = { 'user-agent': 'vozka' }
			if (prior?.etag != null && prior.etag !== '') {
				headers['if-none-match'] = prior.etag
			}
			const response = await deps.fetch(feedUrl, { headers })

			if (response.status === 304) {
				// Feed unchanged — keep the stored ETag + sha, only bump last_polled_at (clears nothing else).
				await deps.db.upsertRepoPollState({
					appId: app.id,
					env: appEnv.env,
					etag: prior?.etag ?? null,
					lastSeenSha: prior?.last_seen_sha ?? null,
					lastPolledAt: polledAt,
					lastError: null,
				})
				summary.unchanged++
				continue
			}

			if (!response.ok) {
				// Non-2xx-non-304 — record a SHORT status (never the body, which can be large) and move on.
				await recordError(deps, app.id, appEnv.env, prior, polledAt, `feed HTTP ${response.status}`, summary)
				continue
			}

			const body = await response.text()
			const latest = parseLatestEntry(body)
			if (latest === null) {
				await recordError(deps, app.id, appEnv.env, prior, polledAt, 'feed unparseable', summary)
				continue
			}

			const etag = response.headers.get('etag')

			if (prior?.last_seen_sha === latest.sha) {
				// Same head as last time — no new commit. Refresh the ETag (it may have changed) + timestamp.
				await deps.db.upsertRepoPollState({
					appId: app.id,
					env: appEnv.env,
					etag,
					lastSeenSha: latest.sha,
					lastPolledAt: polledAt,
					lastError: null,
				})
				summary.unchanged++
				continue
			}

			// New head sha → trigger a deploy of THIS (app, env), exactly like a verified webhook push.
			const run = await deps.db.createRun({
				id: uuidv7(),
				appId: app.id,
				env: appEnv.env,
				ref: triggerRef,
				commitSha: latest.sha,
				trigger: 'poll',
			})
			await deps.queue.send({ runId: run.id })
			await deps.db.upsertRepoPollState({
				appId: app.id,
				env: appEnv.env,
				etag,
				lastSeenSha: latest.sha,
				lastPolledAt: polledAt,
				lastError: null,
			})
			summary.triggered++
		} catch (err) {
			// Never log the error object verbatim (it could carry a URL); a short message only.
			await recordError(deps, app.id, appEnv.env, prior, polledAt, err instanceof Error ? err.message : 'poll error', summary)
		}
	}

	return summary
}

/** Record a SHORT last_error for a failed poll (preserving the prior ETag + sha) and count it. */
async function recordError(
	deps: PollDeps,
	appId: string,
	env: string,
	prior: { etag: string | null; last_seen_sha: string | null } | null,
	polledAt: number,
	message: string,
	summary: PollSummary,
): Promise<void> {
	await deps.db.upsertRepoPollState({
		appId,
		env,
		etag: prior?.etag ?? null,
		lastSeenSha: prior?.last_seen_sha ?? null,
		lastPolledAt: polledAt,
		// Cap the stored error so a long thrown message never bloats the row.
		lastError: message.slice(0, 200),
	})
	summary.errored++
}
