// Vault management handlers: write-only set / rotate / delete of the encrypted per-app secret VALUES
// behind the registry's `app_secrets.value_ref` column. ACL-gated by `secret.manage` (the router does
// the can-check before these run) and audited. VALUES NEVER leave the vault — these endpoints accept a
// value, store it encrypted, and write the resulting `vault:<id>` ref back onto the row. No handler
// ever RETURNS a value, and no value is logged (audit metadata carries only names / refs / scopes).
//
// The vault holds ONLY app/app-env secrets (scope 'app'|'app-env', app-scoped ACL). Platform creds
// (the CF API token, propustka provisioning creds) are vozka's OWN Worker secrets (src/env.ts), not
// vault entries — single-account, so there is no per-account token to manage here.
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
