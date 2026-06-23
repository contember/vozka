-- Vozka control plane — PUBLIC-REPO POLLING (a pull-based deploy trigger alongside the webhook).
--
-- A private app (a GitHub App installation) keeps using the HMAC-gated push webhook. A PUBLIC app
-- (apps.github_installation_id IS NULL) has no installation and so no webhook delivery — vozka instead
-- POLLS the repo's per-branch/tag commits Atom feed on a cron, with conditional GETs (ETag), and
-- enqueues a deploy when the subscribed ref's head changes. Same outcome as a webhook push, pull-based.
--
-- Two changes:
--   1. A new `repo_poll_state` table — the per-(app,env) poll bookkeeping (ETag + last-seen head sha +
--      last-polled time + last error). One row per pollable (app, env); created/updated by the poller.
--   2. Widen the `runs.trigger` CHECK to admit a third source, 'poll', alongside 'webhook' and 'manual'.
--      SQLite can't ALTER a CHECK constraint, so `runs` is rebuilt via the same create-copy-drop-rename
--      pattern as migrations/0003 — the new table is IDENTICAL to 0001's `runs` except for the widened
--      CHECK, and every index on `runs` is recreated to match.

-- ── 1. Per-(app, env) poll state ──────────────────────────────────────────────
--
-- Keyed (app_id, env). `etag` is the feed's last ETag for the conditional GET (If-None-Match), so an
-- unchanged feed comes back 304 with no body. `last_seen_sha` is the head commit the poller last
-- enqueued for — a feed whose newest sha differs from this triggers a deploy. `last_error` records a
-- SHORT diagnostic string on a failed poll (never a response body); cleared on a successful poll.
CREATE TABLE repo_poll_state (
	app_id         TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env            TEXT NOT NULL,                          -- the app_envs.env this state tracks
	etag           TEXT,                                   -- last feed ETag for the conditional GET; NULL = never fetched
	last_seen_sha  TEXT,                                   -- head commit the poller last enqueued for; NULL = none yet
	last_polled_at INTEGER,                                -- unix seconds of the last poll attempt (success or failure)
	last_error     TEXT,                                   -- SHORT diagnostic on a failed poll (never a body); NULL = last poll ok
	PRIMARY KEY (app_id, env)
);

-- ── 2. Widen the runs.trigger CHECK ('webhook','manual') → (+ 'poll') ──────────
--
-- Rebuild `runs` identical to migrations/0001_init.sql except the trigger CHECK now admits 'poll'.
-- Column order, defaults, the status CHECK, and the FK are preserved EXACTLY so existing rows copy 1:1.

CREATE TABLE runs_new (
	id          TEXT PRIMARY KEY,                          -- UUIDv7 (time-sortable), ours
	app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env         TEXT NOT NULL,                             -- target environment (an app_envs.env)
	ref         TEXT NOT NULL,                             -- git ref deployed (branch/tag/sha)
	commit_sha  TEXT,                                      -- resolved commit, once known
	trigger     TEXT NOT NULL CHECK (trigger IN ('webhook','manual','poll')),
	status      TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
	exit_code   INTEGER,                                   -- vozka deploy exit code, once the deploy ran
	log_key     TEXT,                                      -- R2 key of the streamed log (runs/<id>/logs.ndjson)
	created_at  INTEGER NOT NULL DEFAULT (unixepoch()),    -- enqueued
	started_at  INTEGER,                                   -- moved to 'running'
	finished_at INTEGER                                    -- reached a terminal state
);

INSERT INTO runs_new (id, app_id, env, ref, commit_sha, trigger, status, exit_code, log_key, created_at, started_at, finished_at)
	SELECT id, app_id, env, ref, commit_sha, trigger, status, exit_code, log_key, created_at, started_at, finished_at FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

-- Recreate EVERY index that existed on runs (see migrations/0001_init.sql).
CREATE INDEX idx_runs_app_env ON runs(app_id, env, id);
CREATE INDEX idx_runs_status  ON runs(status, id);
