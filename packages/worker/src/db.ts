// All D1 access for the vozka control plane. Prepared statements via `db.prepare(...).bind(...)`,
// grouped by the resource they touch: apps, app_envs, app_secrets, runs. Mirrors propustka's `Db`
// pattern (snake_case row shapes matching migrations/0001_init.sql, `firstRow` for RETURNING
// statements). Caller-generated UUIDv7 ids are stamped in the Worker, never by SQL.
//
// vozka is single-account (see migrations/0003): the CF account/token + propustka coords are vozka's
// OWN Worker config (src/env.ts), not a per-account registry table, so there is no `accounts` access here.

import { uuidv7 } from './uuid'

// ── D1 row shapes (snake_case, as migrations/0001_init.sql defines) ────────────

export interface AppRow {
	id: string
	repo_url: string
	default_branch: string
	worker_dir: string | null
	build_cmd: string | null
	config_path: string | null
	github_installation_id: number | null
	created_at: number
}

export interface AppEnvRow {
	app_id: string
	env: string
	domain: string | null
	/** Git ref that triggers a deploy here, e.g. `refs/heads/deploy/prod`. NULL = manual-only. */
	trigger_ref: string | null
	created_at: number
}

export interface AppSecretRow {
	app_id: string
	/** NULL = applies to every env of the app; set = that env only (narrower wins). */
	env: string | null
	name: string
	/** REFERENCE into the M4 vault — never the plaintext value. */
	value_ref: string
	created_at: number
}

export type RunTrigger = 'webhook' | 'manual'
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface RunRow {
	id: string
	app_id: string
	env: string
	ref: string
	commit_sha: string | null
	trigger: RunTrigger
	status: RunStatus
	exit_code: number | null
	/** R2 key the relay streams the run's log into (runs/<id>/logs.ndjson). */
	log_key: string | null
	created_at: number
	started_at: number | null
	finished_at: number | null
}

/**
 * Run a statement that always returns exactly one row (an `INSERT/UPDATE … RETURNING` we know
 * matched). `.first<T>()` is typed `T | null`; this narrows it to `T`, throwing if the row is
 * unexpectedly absent (a programming/DB error, not normal flow). Mirrors propustka's `firstRow`.
 */
async function firstRow<T>(statement: D1PreparedStatement): Promise<T> {
	const row = await statement.first<T>()
	if (row === null) {
		throw new Error('expected a row from a RETURNING statement, got none')
	}
	return row
}

/** All D1 access for the control plane. */
export class Db {
	constructor(private readonly d1: D1Database) {}

	// ── Apps ────────────────────────────────────────────────────────────────────

	async listApps(): Promise<AppRow[]> {
		const { results } = await this.d1.prepare('SELECT * FROM apps ORDER BY id').all<AppRow>()
		return results
	}

	async getApp(id: string): Promise<AppRow | null> {
		return this.d1.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first<AppRow>()
	}

	/**
	 * The apps registered for a repo URL (the webhook narrows by repo first, then by ref). A repo can
	 * back more than one app entry, so this returns all matches. Matched on the normalized URL (the
	 * caller normalizes both the stored and the incoming URL the same way — see normalizeRepoUrl).
	 */
	async getAppsByRepoUrl(repoUrl: string): Promise<AppRow[]> {
		const { results } = await this.d1.prepare('SELECT * FROM apps WHERE repo_url = ?').bind(repoUrl).all<AppRow>()
		return results
	}

	async createApp(input: {
		id: string
		repoUrl: string
		defaultBranch?: string
		workerDir?: string | null
		buildCmd?: string | null
		configPath?: string | null
		githubInstallationId?: number | null
	}): Promise<AppRow> {
		return firstRow<AppRow>(
			this.d1
				.prepare(`INSERT INTO apps (id, repo_url, default_branch, worker_dir, build_cmd, config_path, github_installation_id)
					VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
				.bind(
					input.id,
					input.repoUrl,
					input.defaultBranch ?? 'main',
					input.workerDir ?? null,
					input.buildCmd ?? null,
					input.configPath ?? null,
					input.githubInstallationId ?? null,
				),
		)
	}

	async updateApp(id: string, patch: {
		repoUrl?: string
		defaultBranch?: string
		workerDir?: string | null
		buildCmd?: string | null
		configPath?: string | null
		githubInstallationId?: number | null
	}): Promise<AppRow | null> {
		return this.d1
			.prepare(`UPDATE apps SET
				repo_url = COALESCE(?, repo_url),
				default_branch = COALESCE(?, default_branch),
				worker_dir = COALESCE(?, worker_dir),
				build_cmd = COALESCE(?, build_cmd),
				config_path = COALESCE(?, config_path),
				github_installation_id = COALESCE(?, github_installation_id)
				WHERE id = ? RETURNING *`)
			.bind(
				patch.repoUrl ?? null,
				patch.defaultBranch ?? null,
				patch.workerDir ?? null,
				patch.buildCmd ?? null,
				patch.configPath ?? null,
				patch.githubInstallationId ?? null,
				id,
			)
			.first<AppRow>()
	}

	async deleteApp(id: string): Promise<boolean> {
		const result = await this.d1.prepare('DELETE FROM apps WHERE id = ?').bind(id).run()
		return (result.meta.changes ?? 0) > 0
	}

	// ── App environments ──────────────────────────────────────────────────────

	async listAppEnvs(appId: string): Promise<AppEnvRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_envs WHERE app_id = ? ORDER BY env')
			.bind(appId)
			.all<AppEnvRow>()
		return results
	}

	async getAppEnv(appId: string, env: string): Promise<AppEnvRow | null> {
		return this.d1.prepare('SELECT * FROM app_envs WHERE app_id = ? AND env = ?').bind(appId, env).first<AppEnvRow>()
	}

	/**
	 * Find the (app, env) a push ref triggers. The webhook narrows to an app first (by repo), then
	 * matches the ref against that app's env trigger_refs — so two apps can use the same branch name.
	 */
	async getAppEnvByTriggerRef(appId: string, triggerRef: string): Promise<AppEnvRow | null> {
		return this.d1
			.prepare('SELECT * FROM app_envs WHERE app_id = ? AND trigger_ref = ?')
			.bind(appId, triggerRef)
			.first<AppEnvRow>()
	}

	/** Upsert an (app, env) target. ON CONFLICT (app_id, env) overwrites the mutable columns. */
	async upsertAppEnv(input: {
		appId: string
		env: string
		domain?: string | null
		triggerRef?: string | null
	}): Promise<AppEnvRow> {
		return firstRow<AppEnvRow>(
			this.d1
				.prepare(`INSERT INTO app_envs (app_id, env, domain, trigger_ref)
					VALUES (?, ?, ?, ?)
					ON CONFLICT (app_id, env) DO UPDATE SET
						domain = excluded.domain,
						trigger_ref = excluded.trigger_ref
					RETURNING *`)
				.bind(
					input.appId,
					input.env,
					input.domain ?? null,
					input.triggerRef ?? null,
				),
		)
	}

	async deleteAppEnv(appId: string, env: string): Promise<boolean> {
		const result = await this.d1.prepare('DELETE FROM app_envs WHERE app_id = ? AND env = ?').bind(appId, env).run()
		return (result.meta.changes ?? 0) > 0
	}

	// ── App secrets (the pipeline.secrets resolution seam; values live in the M4 vault) ──

	/**
	 * The secret rows that apply when deploying `app` to `env`: the all-env layer (env IS NULL) plus
	 * the env-specific layer. The SecretResolver layers narrower (env-specific) over wider (all-env).
	 */
	async getAppSecretsForEnv(appId: string, env: string): Promise<AppSecretRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_secrets WHERE app_id = ? AND (env IS NULL OR env = ?) ORDER BY name')
			.bind(appId, env)
			.all<AppSecretRow>()
		return results
	}

	async listAppSecrets(appId: string): Promise<AppSecretRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_secrets WHERE app_id = ? ORDER BY name, env')
			.bind(appId)
			.all<AppSecretRow>()
		return results
	}

	/** Upsert a secret reference at its (app, env-or-all) layer. The value_ref points into the M4 vault. */
	async upsertAppSecret(input: { appId: string; env: string | null; name: string; valueRef: string }): Promise<AppSecretRow> {
		// NULL env is a distinct layer from a concrete env (partial unique indexes), so the conflict
		// target differs. Two prepared variants keep the ON CONFLICT target correct for each layer.
		if (input.env === null) {
			return firstRow<AppSecretRow>(
				this.d1
					.prepare(`INSERT INTO app_secrets (app_id, env, name, value_ref) VALUES (?, NULL, ?, ?)
						ON CONFLICT (app_id, name) WHERE env IS NULL DO UPDATE SET value_ref = excluded.value_ref
						RETURNING *`)
					.bind(input.appId, input.name, input.valueRef),
			)
		}
		return firstRow<AppSecretRow>(
			this.d1
				.prepare(`INSERT INTO app_secrets (app_id, env, name, value_ref) VALUES (?, ?, ?, ?)
					ON CONFLICT (app_id, env, name) WHERE env IS NOT NULL DO UPDATE SET value_ref = excluded.value_ref
					RETURNING *`)
				.bind(input.appId, input.env, input.name, input.valueRef),
		)
	}

	async deleteAppSecret(appId: string, env: string | null, name: string): Promise<boolean> {
		const result = input(env)
			? await this.d1.prepare('DELETE FROM app_secrets WHERE app_id = ? AND env = ? AND name = ?').bind(appId, env, name).run()
			: await this.d1.prepare('DELETE FROM app_secrets WHERE app_id = ? AND env IS NULL AND name = ?').bind(appId, name).run()
		return (result.meta.changes ?? 0) > 0

		// Local helper: NULL env needs `IS NULL` (a bound NULL never `= NULL`).
		function input(value: string | null): value is string {
			return value !== null
		}
	}

	// ── Runs ────────────────────────────────────────────────────────────────────

	/** Create a run row in `pending`, ready to be enqueued. Returns the inserted row. */
	async createRun(input: {
		id: string
		appId: string
		env: string
		ref: string
		commitSha?: string | null
		trigger: RunTrigger
	}): Promise<RunRow> {
		return firstRow<RunRow>(
			this.d1
				.prepare(`INSERT INTO runs (id, app_id, env, ref, commit_sha, trigger, status)
					VALUES (?, ?, ?, ?, ?, ?, 'pending') RETURNING *`)
				.bind(input.id, input.appId, input.env, input.ref, input.commitSha ?? null, input.trigger),
		)
	}

	async getRun(id: string): Promise<RunRow | null> {
		return this.d1.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>()
	}

	/**
	 * List runs, newest first, optionally filtered by app and/or env. `id` is UUIDv7 (time-sortable),
	 * so ordering by id DESC is chronological; `before` is a keyset cursor for pagination.
	 */
	async listRuns(filter: { appId?: string; env?: string; before?: string; limit: number }): Promise<RunRow[]> {
		const where: string[] = []
		const binds: (string | number)[] = []
		if (filter.appId !== undefined) {
			where.push('app_id = ?')
			binds.push(filter.appId)
		}
		if (filter.env !== undefined) {
			where.push('env = ?')
			binds.push(filter.env)
		}
		if (filter.before !== undefined) {
			where.push('id < ?')
			binds.push(filter.before)
		}
		const sql = `SELECT * FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
		binds.push(filter.limit)
		const { results } = await this.d1.prepare(sql).bind(...binds).all<RunRow>()
		return results
	}

	/**
	 * Move a run `pending → running`: stamp `started_at` and the R2 log key. Guarded on the current
	 * status so a redelivered queue message can't re-start a run already past pending. Returns true
	 * iff the row transitioned.
	 */
	async markRunStarted(id: string, logKey: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE runs SET status = 'running', started_at = unixepoch(), log_key = ?
				WHERE id = ? AND status = 'pending'`)
			.bind(logKey, id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Record the resolved commit sha for a run (once the ref is resolved by the runner). */
	async setRunCommit(id: string, commitSha: string): Promise<void> {
		await this.d1.prepare('UPDATE runs SET commit_sha = ? WHERE id = ?').bind(commitSha, id).run()
	}

	/**
	 * Move a run to a terminal state (`succeeded` | `failed`): stamp `finished_at` + the exit code.
	 * Returns true iff the row transitioned (it was still `running`/`pending`).
	 */
	async markRunFinished(id: string, status: 'succeeded' | 'failed', exitCode: number | null): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE runs SET status = ?, exit_code = ?, finished_at = unixepoch()
				WHERE id = ? AND status IN ('pending','running')`)
			.bind(status, exitCode, id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}
}

export { uuidv7 }
