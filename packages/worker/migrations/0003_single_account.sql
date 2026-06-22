-- Vozka control plane — collapse to SINGLE-ACCOUNT (drop the multi-account registry).
--
-- vozka is single-CF-account by design: Cloudflare Access apps are per-account, so one propustka
-- instance governs one account, vozka (gated by that propustka) runs on that account, and the apps
-- vozka deploys reconcile into that same propustka — all one account. A second account gets its OWN
-- propustka + vozka. So the per-account registry was YAGNI.
--
-- After this migration the deploy target is vozka's OWN Worker config (src/env.ts), not a registry row:
--   * CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN — vozka's single account/token (var + Worker secret).
--   * PROPUSTKA_URL + PROPUSTKA_CLIENT_ID/SECRET   — the one propustka's coords + provisioning key.
-- These are injected into EVERY deploy job; WHETHER a deploy reconciles is decided by the app's own
-- config (`access`/`schema` presence), not the registry.
--
-- Changes:
--   1. DROP the `accounts` table (per-account CF id + token ref).
--   2. Rebuild `app_envs` without `account_name` (the per-env account pointer) and `propustka_url`
--      (now vozka build-time config) — keep only the genuinely per-(app,env) columns: domain + trigger.
--   3. Tighten the `vault.scope` CHECK to the app-specific scopes the vault actually holds now
--      ('app','app-env'); the 'global'/'account' scopes had no remaining writer once account tokens
--      left the vault.
--
-- SQLite has no DROP COLUMN that also drops a FK / partial index cleanly, so app_envs + vault are
-- rebuilt via the create-copy-drop-rename pattern. ON CONFLICT/PK/indexes are recreated to match.

-- ── 1. Drop the per-account registry ──────────────────────────────────────────
-- Rebuild app_envs FIRST (it carries the FK to accounts), then accounts has no referrer left to drop.

CREATE TABLE app_envs_new (
	app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env         TEXT NOT NULL,                          -- e.g. 'prod' | 'stage'
	domain      TEXT,                                   -- public domain for this stage; NULL = *.workers.dev
	trigger_ref TEXT,                                   -- git ref that triggers a deploy here; NULL = manual-only
	created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (app_id, env)
);

INSERT INTO app_envs_new (app_id, env, domain, trigger_ref, created_at)
	SELECT app_id, env, domain, trigger_ref, created_at FROM app_envs;

DROP TABLE app_envs;
ALTER TABLE app_envs_new RENAME TO app_envs;

-- A push ref is unique within an app (you can't point two of an app's envs at the same branch).
CREATE UNIQUE INDEX idx_app_envs_trigger ON app_envs(app_id, trigger_ref) WHERE trigger_ref IS NOT NULL;

DROP TABLE accounts;

-- ── 2. Tighten the vault scope to the app-specific values it now holds ─────────

CREATE TABLE vault_new (
	id          TEXT PRIMARY KEY,
	scope       TEXT NOT NULL CHECK (scope IN ('app','app-env')),
	label       TEXT,
	ciphertext  TEXT NOT NULL,
	value_iv    TEXT NOT NULL,
	wrapped_dek TEXT NOT NULL,
	dek_iv      TEXT NOT NULL,
	created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
	rotated_at  INTEGER
);

-- Carry over only app/app-env entries (account/global scopes are gone with the account registry).
INSERT INTO vault_new SELECT * FROM vault WHERE scope IN ('app','app-env');

DROP TABLE vault;
ALTER TABLE vault_new RENAME TO vault;
CREATE INDEX idx_vault_scope ON vault(scope);
