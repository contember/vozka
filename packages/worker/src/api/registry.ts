// Registry + onboarding REST handlers: CRUD for apps, app_envs, app_secrets, plus the onboarding
// action `registerApp` (the "paste a repo + domain" entry that creates the app + its first app_env in
// one call). Every handler is ACL-gated by the router (src/api/router.ts) before it runs.
//
// Mutations audit through the authenticated `AuthContext` (propustka `audit`). Secret VALUES are stored
// as REFERENCES only (`value_ref`) — the plaintext vault is in src/vault.ts. A create endpoint accepts
// a ref, never a raw value. vozka is single-account, so there is no `accounts` resource: the CF
// account/token + propustka coords are vozka's own Worker config (src/env.ts).

import type { AppEnvRow, AppRow, AppSecretRow, AppVarRow, Db } from '../db'
import { error, json, readJson } from '../http'
import type { Authorized } from '../iam'
import { arrayField, booleanField, nullableStringField, numberField, stringField } from '../json'
import { normalizeRepoUrl } from '../repo-source'

/** Context every registry handler receives. */
export interface RegistryContext {
	db: Db
	request: Request
	url: URL
	/** The authenticated caller (already `can`-checked by the router); used to `audit` mutations. */
	authorized: Authorized
}

// ── DTO mappers (snake_case row → camelCase API; secrets stay refs) ────────────

function toAppDto(row: AppRow): unknown {
	return {
		id: row.id,
		repoUrl: row.repo_url,
		defaultBranch: row.default_branch,
		workerDir: row.worker_dir,
		buildCmd: row.build_cmd,
		configPath: row.config_path,
		githubInstallationId: row.github_installation_id,
		createdAt: row.created_at,
	}
}
function toAppEnvDto(row: AppEnvRow): unknown {
	return {
		appId: row.app_id,
		env: row.env,
		domain: row.domain,
		triggerRef: row.trigger_ref,
		createdAt: row.created_at,
	}
}
function toAppSecretDto(row: AppSecretRow): unknown {
	// value_ref IS exposed (it's a reference, not the value) — the dashboard needs to show which ref a
	// secret maps to. The actual value never leaves the vault (M4).
	return { appId: row.app_id, env: row.env, name: row.name, valueRef: row.value_ref, createdAt: row.created_at }
}

// ── Apps ──────────────────────────────────────────────────────────────────────

export async function listApps(c: RegistryContext): Promise<Response> {
	const rows = await c.db.listApps()
	return json({ items: rows.map(toAppDto) })
}

export async function getApp(c: RegistryContext, id: string): Promise<Response> {
	const row = await c.db.getApp(id)
	return row ? json(toAppDto(row)) : error(404, 'app not found')
}

export async function createApp(c: RegistryContext): Promise<Response> {
	const body = await readJson(c.request)
	const id = stringField(body, 'id')
	const repoUrl = stringField(body, 'repoUrl')
	if (!id || !repoUrl) {
		return error(400, 'id and repoUrl required')
	}
	if (await c.db.getApp(id)) {
		return error(409, 'an app with this id already exists')
	}
	// Store the NORMALIZED repo URL so the webhook's normalized push URL matches it (see
	// normalizeRepoUrl). The original form is not needed — the canonical host/owner/repo is the key.
	const row = await c.db.createApp({
		id,
		repoUrl: normalizeRepoUrl(repoUrl),
		...optionalAppFields(body),
	})
	await c.authorized.auth.audit({ action: 'app.create', resourceType: 'app', resourceId: id, metadata: { repoUrl: row.repo_url } })
	return json(toAppDto(row), { status: 201 })
}

export async function updateApp(c: RegistryContext, id: string): Promise<Response> {
	const existing = await c.db.getApp(id)
	if (!existing) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const repoUrl = stringField(body, 'repoUrl')
	const row = await c.db.updateApp(id, {
		...(repoUrl !== undefined ? { repoUrl: normalizeRepoUrl(repoUrl) } : {}),
		...optionalAppFields(body),
	})
	await c.authorized.auth.audit({ action: 'app.update', resourceType: 'app', resourceId: id })
	return row ? json(toAppDto(row)) : error(404, 'app not found')
}

export async function deleteApp(c: RegistryContext, id: string): Promise<Response> {
	const ok = await c.db.deleteApp(id)
	if (!ok) {
		return error(404, 'app not found')
	}
	await c.authorized.auth.audit({ action: 'app.delete', resourceType: 'app', resourceId: id })
	return json({ ok: true })
}

/** Shared optional-column reader for create/update app (defaultBranch / dirs / build / install id). */
function optionalAppFields(body: unknown): {
	defaultBranch?: string
	workerDir?: string | null
	buildCmd?: string | null
	configPath?: string | null
	githubInstallationId?: number | null
} {
	const defaultBranch = stringField(body, 'defaultBranch')
	const workerDir = nullableStringField(body, 'workerDir')
	const buildCmd = nullableStringField(body, 'buildCmd')
	const configPath = nullableStringField(body, 'configPath')
	const githubInstallationId = numberField(body, 'githubInstallationId')
	return {
		...(defaultBranch !== undefined ? { defaultBranch } : {}),
		...(workerDir !== undefined ? { workerDir } : {}),
		...(buildCmd !== undefined ? { buildCmd } : {}),
		...(configPath !== undefined ? { configPath } : {}),
		...(githubInstallationId !== undefined ? { githubInstallationId } : {}),
	}
}

// ── App environments ──────────────────────────────────────────────────────────

export async function listAppEnvs(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const rows = await c.db.listAppEnvs(appId)
	return json({ items: rows.map(toAppEnvDto) })
}

export async function putAppEnv(c: RegistryContext, appId: string, env: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const domain = nullableStringField(body, 'domain') ?? null
	const triggerRef = nullableStringField(body, 'triggerRef') ?? null
	const row = await c.db.upsertAppEnv({ appId, env, domain, triggerRef })
	await c.authorized.auth.audit({
		action: 'app.env.upsert',
		resourceType: 'app_env',
		resourceId: `${appId}/${env}`,
		metadata: { triggerRef },
	})
	return json(toAppEnvDto(row))
}

export async function deleteAppEnv(c: RegistryContext, appId: string, env: string): Promise<Response> {
	const ok = await c.db.deleteAppEnv(appId, env)
	if (!ok) {
		return error(404, 'app env not found')
	}
	await c.authorized.auth.audit({ action: 'app.env.delete', resourceType: 'app_env', resourceId: `${appId}/${env}` })
	return json({ ok: true })
}

// ── App secrets (refs only; the M4 vault fills values) ─────────────────────────

export async function listAppSecrets(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const rows = await c.db.listAppSecrets(appId)
	return json({ items: rows.map(toAppSecretDto) })
}

export async function putAppSecret(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const name = stringField(body, 'name')
	const valueRef = stringField(body, 'valueRef')
	if (!name || !valueRef) {
		return error(400, 'name and valueRef required (valueRef is a vault reference, never the value)')
	}
	// env null = all-env layer; a string narrows it to that env.
	const env = nullableStringField(body, 'env') ?? null
	const row = await c.db.upsertAppSecret({ appId, env, name, valueRef })
	await c.authorized.auth.audit({
		action: 'app.secret.upsert',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		// NEVER log the ref's tail beyond the name — the ref scheme is fine, the value is not present.
		metadata: { name, env },
	})
	return json(toAppSecretDto(row))
}

export async function deleteAppSecret(c: RegistryContext, appId: string, name: string): Promise<Response> {
	// env is a query param (?env=); absent → the all-env layer.
	const envParam = c.url.searchParams.get('env')
	const env = envParam === null || envParam === '' ? null : envParam
	const ok = await c.db.deleteAppSecret(appId, env, name)
	if (!ok) {
		return error(404, 'secret not found')
	}
	await c.authorized.auth.audit({ action: 'app.secret.delete', resourceType: 'app_secret', resourceId: `${appId}/${env ?? '*'}/${name}` })
	return json({ ok: true })
}

// ── App vars (non-secret deploy-time config; PLAINTEXT, readable — unlike secrets) ──

function toAppVarDto(row: AppVarRow): unknown {
	// `value` IS exposed: these are NON-secret per-app-env config (e.g. PROPUSTKA_ACCESS_APPS). Secrets
	// (app_secrets) expose only a ref; vars are plaintext config the dashboard can show + edit.
	return { appId: row.app_id, env: row.env, name: row.name, value: row.value, createdAt: row.created_at }
}

export async function listAppVars(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const rows = await c.db.listAppVars(appId)
	return json({ items: rows.map(toAppVarDto) })
}

export async function putAppVar(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const name = stringField(body, 'name')
	const value = stringField(body, 'value')
	if (!name || !value) {
		return error(400, 'name and value required (value is plaintext config — use a secret for sensitive values)')
	}
	// env null = all-env layer; a string narrows it to that env.
	const env = nullableStringField(body, 'env') ?? null
	const row = await c.db.upsertAppVar({ appId, env, name, value })
	await c.authorized.auth.audit({
		action: 'app.var.upsert',
		resourceType: 'app_var',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		// NEVER log the value — even though it's non-secret, treat config as untrusted; only name + env.
		metadata: { name, env },
	})
	return json(toAppVarDto(row))
}

export async function deleteAppVar(c: RegistryContext, appId: string, name: string): Promise<Response> {
	// env is a query param (?env=); absent → the all-env layer.
	const envParam = c.url.searchParams.get('env')
	const env = envParam === null || envParam === '' ? null : envParam
	const ok = await c.db.deleteAppVar(appId, env, name)
	if (!ok) {
		return error(404, 'var not found')
	}
	await c.authorized.auth.audit({ action: 'app.var.delete', resourceType: 'app_var', resourceId: `${appId}/${env ?? '*'}/${name}` })
	return json({ ok: true })
}

// ── Onboarding ──────────────────────────────────────────────────────────────

/**
 * The "paste a repo + domain" entry: create the app + its first app_env in one call. Idempotency is
 * left to the caller (a duplicate id is a 409). Optional fields shape the registry rows (worker dir,
 * build cmd, domain, trigger ref, install id). The deploy target account is vozka's own (single-account).
 */
export async function registerApp(c: RegistryContext): Promise<Response> {
	const body = await readJson(c.request)
	const id = stringField(body, 'id')
	const repoUrl = stringField(body, 'repoUrl')
	const env = stringField(body, 'env')
	if (!id || !repoUrl || !env) {
		return error(400, 'id, repoUrl and env required')
	}
	if (await c.db.getApp(id)) {
		return error(409, 'an app with this id already exists')
	}
	const app = await c.db.createApp({ id, repoUrl: normalizeRepoUrl(repoUrl), ...optionalAppFields(body) })
	const domain = nullableStringField(body, 'domain') ?? null
	const triggerRef = nullableStringField(body, 'triggerRef') ?? null
	const appEnv = await c.db.upsertAppEnv({ appId: id, env, domain, triggerRef })
	await c.authorized.auth.audit({
		action: 'app.create',
		resourceType: 'app',
		resourceId: id,
		metadata: { repoUrl, env, onboarding: true },
	})
	return json({ app: toAppDto(app), env: toAppEnvDto(appEnv) }, { status: 201 })
}

// Re-export the field readers the router uses to validate query params consistently.
export { arrayField, booleanField }
