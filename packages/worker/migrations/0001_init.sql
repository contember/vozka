-- Vozka control plane — initial schema.
--
-- The control plane owns the deploy REGISTRY (who is deployable, where, with which creds) and the
-- RUN HISTORY (what was deployed, when, with what outcome). Two concerns with opposite shapes:
--   * registry — mutable current state, read on every trigger/deploy (accounts/apps/envs/secrets).
--   * runs     — append-mostly history, one row per deploy, mutated through its lifecycle.
--
-- Convention (mirrors propustka/0001): self-owned string ids are caller-generated (UUIDv7 in the
-- Worker, never filled by SQL), `unixepoch()` defaults stamp creation time in seconds, and snake_case
-- columns match the row shapes in src/db.ts.
--
-- CREDENTIALS / SECRETS ARE STORED AS REFERENCES ONLY (the `*_ref` columns). The encrypted vault that
-- those refs resolve against is M4 — this migration deliberately stores only the opaque reference, so
-- M4 can wire the vault without a schema change. Never store a plaintext CF API token or secret value
-- in these tables.

-- ── Accounts (Cloudflare accounts vozka can deploy into) ──────────────────────
--
-- One row per Cloudflare account. `name` is a stable human handle used as the PK and referenced by
-- app_envs. `cf_api_token_ref` is a VAULT REFERENCE (M4), never the plaintext token.
CREATE TABLE accounts (
	name             TEXT PRIMARY KEY,                  -- stable handle, e.g. 'contember-prod'; app_envs reference this
	cf_account_id    TEXT NOT NULL,                     -- the Cloudflare account id (32-hex); not secret
	cf_api_token_ref TEXT NOT NULL,                     -- REFERENCE into the M4 vault; NEVER the plaintext token
	created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── Apps (the deploy registry) ────────────────────────────────────────────────
--
-- One row per deployable app — the "paste a repo + domain" entry. Holds WHERE the source lives and
-- HOW to build it; per-environment targets (account/domain/trigger) live in app_envs. The GitHub App
-- installation id (when onboarded via the GitHub App) lets the control plane mint clone tokens.
CREATE TABLE apps (
	id                      TEXT PRIMARY KEY,            -- stable app id (the AppConfig.id); drives resource + propustka naming
	repo_url                TEXT NOT NULL,               -- git remote, e.g. https://github.com/acme/app.git
	default_branch          TEXT NOT NULL DEFAULT 'main',-- branch a manual deploy uses when no ref is given
	worker_dir              TEXT,                        -- sub-dir within the clone the config lives in; NULL = '.'
	build_cmd               TEXT,                        -- override build command; NULL = use the config's pipeline.build
	config_path             TEXT,                        -- config file path relative to worker_dir; NULL = vozka.config.ts
	github_installation_id  INTEGER,                     -- GitHub App installation id (clone-token minting); NULL = public/direct
	created_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_apps_installation ON apps(github_installation_id);

-- ── App environments (per-app deploy targets) ────────────────────────────────
--
-- One row per (app, env): which account to deploy into, the public domain, the propustka IAM base
-- URL (when the app reconciles access/schema), and the git ref that triggers a deploy to THIS env.
-- A push whose ref equals `trigger_ref` deploys the app to `env` (see src/repo-source.ts ref→env).
-- PK (app_id, env): an app has at most one row per environment.
CREATE TABLE app_envs (
	app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env           TEXT NOT NULL,                          -- e.g. 'prod' | 'stage'
	account_name  TEXT NOT NULL REFERENCES accounts(name),-- which Cloudflare account this env deploys into
	domain        TEXT,                                   -- public domain for this stage; NULL = *.workers.dev
	propustka_url TEXT,                                   -- propustka IAM base URL for reconcile; NULL = no reconcile
	trigger_ref   TEXT,                                   -- git ref that triggers a deploy here, e.g. 'refs/heads/deploy/prod'; NULL = manual-only
	created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (app_id, env)
);

-- The webhook maps a push ref → (app, env) via this lookup. A ref is unique within an app (you can't
-- point two of an app's envs at the same branch), enforced by a partial unique index (NULLs distinct).
CREATE UNIQUE INDEX idx_app_envs_trigger ON app_envs(app_id, trigger_ref) WHERE trigger_ref IS NOT NULL;

-- ── App secrets (the pipeline.secrets resolution seam) ────────────────────────
--
-- One row per secret an app's deploy needs (the names the app declares in `pipeline.secrets`). `env`
-- NULL = applies to every environment of the app; a non-null `env` narrows it to that environment
-- (the narrower row wins at resolution). `value_ref` is a VAULT REFERENCE (M4), never the plaintext
-- value — the SecretResolver (src/secret-resolver.ts) turns refs into values at deploy time.
CREATE TABLE app_secrets (
	app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env        TEXT,                                      -- NULL = all envs of the app; set = that env only (narrower wins)
	name       TEXT NOT NULL,                             -- the secret name the app declares in pipeline.secrets
	value_ref  TEXT NOT NULL,                             -- REFERENCE into the M4 vault; NEVER the plaintext value
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- A secret name is unique within an (app, env) layer. NULL env (all-env layer) and a concrete env are
-- distinct layers, so partial unique indexes (the same NULL-in-UNIQUE trap as propustka's grants):
CREATE UNIQUE INDEX idx_app_secrets_uq_env ON app_secrets(app_id, env, name) WHERE env IS NOT NULL;
CREATE UNIQUE INDEX idx_app_secrets_uq_all ON app_secrets(app_id, name)      WHERE env IS NULL;

-- ── Runs (deploy history + live lifecycle) ────────────────────────────────────
--
-- One row per deploy run, created `pending` at trigger time and moved through its lifecycle by the
-- queue consumer + relay (pending → running → succeeded|failed). `log_key` points at the R2 object the
-- relay streams logs into (runs/<id>/logs.ndjson); `commit_sha` is filled once the ref is resolved.
CREATE TABLE runs (
	id          TEXT PRIMARY KEY,                          -- UUIDv7 (time-sortable), ours
	app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env         TEXT NOT NULL,                             -- target environment (an app_envs.env)
	ref         TEXT NOT NULL,                             -- git ref deployed (branch/tag/sha)
	commit_sha  TEXT,                                      -- resolved commit, once known
	trigger     TEXT NOT NULL CHECK (trigger IN ('webhook','manual')),
	status      TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
	exit_code   INTEGER,                                   -- vozka deploy exit code, once the deploy ran
	log_key     TEXT,                                      -- R2 key of the streamed log (runs/<id>/logs.ndjson)
	created_at  INTEGER NOT NULL DEFAULT (unixepoch()),    -- enqueued
	started_at  INTEGER,                                   -- moved to 'running'
	finished_at INTEGER                                    -- reached a terminal state
);

CREATE INDEX idx_runs_app_env ON runs(app_id, env, id);
CREATE INDEX idx_runs_status  ON runs(status, id);
