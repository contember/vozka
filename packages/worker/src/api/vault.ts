// Vault management handlers (M4): write-only set / rotate / delete of the encrypted secret VALUES
// behind the registry's `*_ref` columns. ACL-gated by `secret.manage` (the router does the can-check
// before these run) and audited. VALUES NEVER leave the vault — these endpoints accept a value, store
// it encrypted, and write the resulting `vault:<id>` ref back onto the row. No handler ever RETURNS a
// value, and no value is logged (audit metadata carries only names / refs / scopes).
//
// Two subjects, same vault:
//   * an ACCOUNT's CF API token value      → onto accounts.cf_api_token_ref (scope 'account', global ACL)
//   * an APP / APP-ENV secret value        → onto app_secrets.value_ref      (scope 'app'|'app-env', app ACL)
//
// On SET: store a fresh vault entry, then write its ref onto the row. If the row already pointed at a
// vault ref, the old entry is deleted (no orphaned ciphertext) — unless it was a non-vault ref (e.g.
// `env:`/`secretstore:`), which is left untouched (we don't own it). ROTATE re-encrypts the value at
// the row's existing vault ref in place. DELETE removes the vault entry (the row keeps its now-dangling
// ref; deleting the row itself is the registry's job).

import type { SecretScope } from '@vozka/core'
import type { Db } from '../db'
import { error, json, readJson } from '../http'
import type { Authorized } from '../iam'
import { stringField } from '../json'
import { parseVaultRef, type Vault } from '../vault'

/** Context the vault handlers receive — the Db, the (constructed) Vault, and the auditing caller. */
export interface VaultContext {
	db: Db
	vault: Vault
	request: Request
	url: URL
	authorized: Authorized
}

/**
 * `PUT /api/accounts/:name/token` — set the account's CF API token VALUE (body `{ value }`). Stores it
 * in the vault and writes the `vault:<id>` ref onto accounts.cf_api_token_ref. Replaces (and deletes)
 * any prior vault entry. Write-only: returns `{ ok, cfApiTokenRef }`, never the value.
 */
export async function setAccountToken(c: VaultContext, name: string): Promise<Response> {
	const account = await c.db.getAccount(name)
	if (!account) {
		return error(404, 'account not found')
	}
	const value = await readValue(c.request)
	if (value === undefined) {
		return error(400, 'value required')
	}
	const ref = await c.vault.putSecret('account', `account:${name}/cf_api_token`, value)
	await c.db.updateAccount(name, { cfApiTokenRef: ref })
	await deletePriorVaultEntry(c.vault, account.cf_api_token_ref)
	await c.authorized.auth.audit({
		action: 'account.token.set',
		resourceType: 'account',
		resourceId: name,
		metadata: { cfApiTokenRef: ref },
	})
	return json({ ok: true, cfApiTokenRef: ref })
}

/** `PATCH /api/accounts/:name/token` — re-encrypt the token VALUE in place (body `{ value }`). */
export async function rotateAccountToken(c: VaultContext, name: string): Promise<Response> {
	const account = await c.db.getAccount(name)
	if (!account) {
		return error(404, 'account not found')
	}
	const value = await readValue(c.request)
	if (value === undefined) {
		return error(400, 'value required')
	}
	if (parseVaultRef(account.cf_api_token_ref) === null) {
		return error(409, 'account token is not stored in the vault — set it first')
	}
	await c.vault.rotate(account.cf_api_token_ref, value)
	await c.authorized.auth.audit({ action: 'account.token.rotate', resourceType: 'account', resourceId: name })
	return json({ ok: true })
}

/** `DELETE /api/accounts/:name/token` — remove the vault entry for the account's token (ref left dangling). */
export async function deleteAccountToken(c: VaultContext, name: string): Promise<Response> {
	const account = await c.db.getAccount(name)
	if (!account) {
		return error(404, 'account not found')
	}
	if (parseVaultRef(account.cf_api_token_ref) === null) {
		return error(409, 'account token is not stored in the vault')
	}
	const removed = await c.vault.delete(account.cf_api_token_ref)
	await c.authorized.auth.audit({ action: 'account.token.delete', resourceType: 'account', resourceId: name })
	return json({ ok: removed })
}

/**
 * `PUT /api/apps/:id/secrets/:name/value` — set an app/app-env secret VALUE (body `{ value, env? }`).
 * Stores it in the vault and upserts the app_secrets row with the `vault:<id>` ref. `env` null/omitted
 * = the all-env layer; a string narrows it to that env. Replaces any prior vault entry for the layer.
 */
export async function setAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const value = stringField(body, 'value')
	if (value === undefined) {
		return error(400, 'value required')
	}
	const env = readEnv(c.url, body)
	const scope: SecretScope = env === null ? 'app' : 'app-env'
	const prior = await findAppSecretRef(c.db, appId, env, name)
	const ref = await c.vault.putSecret(scope, `${scope}:${appId}/${env ?? '*'}/${name}`, value)
	await c.db.upsertAppSecret({ appId, env, name, valueRef: ref })
	if (prior !== null) {
		await deletePriorVaultEntry(c.vault, prior)
	}
	await c.authorized.auth.audit({
		action: 'app.secret.set',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env, valueRef: ref },
	})
	return json({ ok: true, valueRef: ref })
}

/** `PATCH /api/apps/:id/secrets/:name/value` — re-encrypt the secret VALUE in place (body `{ value, env? }`). */
export async function rotateAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const value = stringField(body, 'value')
	if (value === undefined) {
		return error(400, 'value required')
	}
	const env = readEnv(c.url, body)
	const ref = await findAppSecretRef(c.db, appId, env, name)
	if (ref === null) {
		return error(404, 'secret not found')
	}
	if (parseVaultRef(ref) === null) {
		return error(409, 'secret is not stored in the vault — set it first')
	}
	await c.vault.rotate(ref, value)
	await c.authorized.auth.audit({
		action: 'app.secret.rotate',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env },
	})
	return json({ ok: true })
}

/** `DELETE /api/apps/:id/secrets/:name/value?env=` — remove the vault entry (ref left dangling on the row). */
export async function deleteAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const env = readEnv(c.url, undefined)
	const ref = await findAppSecretRef(c.db, appId, env, name)
	if (ref === null) {
		return error(404, 'secret not found')
	}
	if (parseVaultRef(ref) === null) {
		return error(409, 'secret is not stored in the vault')
	}
	const removed = await c.vault.delete(ref)
	await c.authorized.auth.audit({
		action: 'app.secret.value.delete',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env },
	})
	return json({ ok: removed })
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Read the write-only `{ value }` body. undefined when absent or not a string (caller 400s). */
async function readValue(request: Request): Promise<string | undefined> {
	const body = await readJson(request)
	return stringField(body, 'value')
}

/** The secret layer: `?env=` (query) or `env` (body); empty/absent → null (the all-env layer). */
function readEnv(url: URL, body: unknown): string | null {
	const fromBody = body === undefined ? undefined : stringField(body, 'env')
	const raw = fromBody ?? url.searchParams.get('env') ?? null
	return raw === null || raw === '' ? null : raw
}

/** The current `value_ref` for an (app, env, name) secret layer, or null when no such row exists. */
async function findAppSecretRef(db: Db, appId: string, env: string | null, name: string): Promise<string | null> {
	const rows = await db.listAppSecrets(appId)
	const match = rows.find((r) => r.name === name && r.env === env)
	return match ? match.value_ref : null
}

/** Delete a prior VAULT entry when replacing a ref, so no orphaned ciphertext lingers. Non-vault refs are left alone. */
async function deletePriorVaultEntry(vault: Vault, priorRef: string): Promise<void> {
	if (parseVaultRef(priorRef) !== null) {
		await vault.delete(priorRef)
	}
}
