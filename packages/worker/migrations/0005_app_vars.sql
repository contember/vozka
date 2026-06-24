-- M5: app_vars — NON-SECRET per-app deploy-time config vars (e.g. propustka's PROPUSTKA_ACCESS_APPS /
-- PROPUSTKA_TEAM / PROPUSTKA_HUMAN_*, poplach's INGEST_QUEUE_ID). Mirrors app_secrets' (app, env)
-- layering, but the VALUE is stored in PLAINTEXT — these are environment/account-specific CONFIG, not
-- secrets (so they're readable over the API, unlike the write-only vault). The engine injects them into
-- the deploy child's process.env so a migrated config reads them via `process.env['NAME']`, the same way
-- its oblaka.ts did. Secrets stay in the vault (app_secrets.value_ref); vars never touch it.
CREATE TABLE app_vars (
	app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env        TEXT,                                      -- NULL = all envs of the app; set = that env only (narrower wins)
	name       TEXT NOT NULL,                             -- the var name the app declares in pipeline.vars
	value      TEXT NOT NULL,                             -- PLAINTEXT config value (non-secret)
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- A var name is unique within an (app, env) layer; NULL env (all-env) and a concrete env are distinct
-- layers (the same NULL-in-UNIQUE partial-index handling as app_secrets).
CREATE UNIQUE INDEX idx_app_vars_uq_env ON app_vars(app_id, env, name) WHERE env IS NOT NULL;
CREATE UNIQUE INDEX idx_app_vars_uq_all ON app_vars(app_id, name)      WHERE env IS NULL;
