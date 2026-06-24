/**
 * Cloudflare API helpers for the bootstrap wizard — token verification, account resolution, and a
 * best-effort zone lookup. These run from the operator's laptop against the public CF API with the
 * token the operator just pasted; the token VALUE is never logged here (only pass/fail + names).
 *
 * Every response shape is a minimal local `interface` narrowed with runtime checks (no `as`, no
 * `any`) — the CF API returns a uniform `{ success, result, errors }` envelope we validate before
 * trusting any field.
 */

import { fromEnv } from './envfile'
import { isRecord, prop, stringProp } from './narrow'
import { required, select } from './prompt'

const CF_API = 'https://api.cloudflare.com/client/v4'

/** The CF account picked for this deploy (id + human name, for display). */
export interface CfAccount {
	id: string
	name: string
}

/** A resolved CF zone (registrable domain) — null when the domain isn't on the account. */
export interface CfZone {
	id: string
	name: string
}

/** The first `errors[].message` from a CF envelope, or undefined — for a readable failure message. */
function firstErrorMessage(body: unknown): string | undefined {
	const errors = prop(body, 'errors')
	if (!Array.isArray(errors)) {
		return undefined
	}
	for (const entry of errors) {
		const message = stringProp(entry, 'message')
		if (message !== undefined) {
			return message
		}
	}
	return undefined
}

/**
 * Parse the uniform CF envelope `{ success, result, errors }`, throwing a short message (never the
 * token) on a non-2xx / `success:false`. Returns the `result` field as `unknown` for the caller to
 * narrow. All field access is runtime-checked — no casts.
 */
async function cfJson(response: Response, what: string): Promise<unknown> {
	const body: unknown = await response.json().catch(() => null)
	if (!isRecord(body) || typeof prop(body, 'success') !== 'boolean') {
		throw new Error(`${what}: unexpected Cloudflare response (HTTP ${response.status}).`)
	}
	if (!response.ok || prop(body, 'success') !== true) {
		throw new Error(`${what} failed: ${firstErrorMessage(body) ?? `HTTP ${response.status}`}`)
	}
	return prop(body, 'result')
}

/** Authorization header for the token. Kept local so the value never leaks into a log statement. */
function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` }
}

/**
 * Best-effort token liveness check → true iff Cloudflare reports the token `active`. Tries the
 * ACCOUNT-scoped endpoint first when an account id is known: an ACCOUNT-OWNED token is NOT visible to
 * `/user/tokens/verify` (which returns "Invalid API Token" for it) — only `/accounts/<id>/tokens/verify`
 * sees it — then falls back to the user endpoint. NEVER throws: a `false` means "couldn't confirm", and
 * the caller decides whether to proceed (the real deploy is the ultimate check).
 */
export async function verifyToken(token: string, accountId?: string): Promise<boolean> {
	const endpoints = accountId !== undefined && accountId !== ''
		? [`${CF_API}/accounts/${accountId}/tokens/verify`, `${CF_API}/user/tokens/verify`]
		: [`${CF_API}/user/tokens/verify`]
	for (const endpoint of endpoints) {
		try {
			const response = await fetch(endpoint, { headers: authHeaders(token) })
			const result = await cfJson(response, 'Token verification')
			if (stringProp(result, 'status') === 'active') {
				return true
			}
		} catch {
			// Not fatal — the token may simply be the wrong TYPE for this endpoint; try the next.
		}
	}
	return false
}

/** List the accounts the token can act on: `GET /accounts`. */
export async function listAccounts(token: string): Promise<CfAccount[]> {
	const response = await fetch(`${CF_API}/accounts`, { headers: authHeaders(token) })
	const result = await cfJson(response, 'Listing accounts')
	if (!Array.isArray(result)) {
		return []
	}
	const accounts: CfAccount[] = []
	for (const entry of result) {
		const id = stringProp(entry, 'id')
		const name = stringProp(entry, 'name')
		if (id !== undefined && name !== undefined) {
			accounts.push({ id, name })
		}
	}
	return accounts
}

/**
 * Resolve the CF account to deploy into. If `preferred` is given and valid, use it; if the token can
 * act on exactly one account, use it; otherwise prompt the operator to pick. Throws if the token can
 * reach no account at all.
 */
export async function resolveAccountId(token: string, preferred?: string): Promise<CfAccount> {
	let accounts: CfAccount[] = []
	try {
		accounts = await listAccounts(token)
	} catch {
		accounts = []
	}
	// An explicit override wins: a `preferred` arg or CLOUDFLARE_ACCOUNT_ID from the environment.
	const wanted = preferred !== undefined && preferred !== '' ? preferred : fromEnv('CLOUDFLARE_ACCOUNT_ID')
	if (wanted !== undefined && wanted !== '') {
		return accounts.find((a) => a.id === wanted) ?? { id: wanted, name: '(from CLOUDFLARE_ACCOUNT_ID)' }
	}
	const only = accounts[0]
	if (accounts.length === 1 && only !== undefined) {
		return only
	}
	if (accounts.length > 1) {
		return select(
			'Which Cloudflare account should vozka deploy into?',
			accounts.map((a) => ({ label: `${a.name} (${a.id})`, value: a })),
		)
	}
	// The token can't list any account (typical for an account-owned token) — ask for the id directly.
	const id = await required('Cloudflare account id (from the dashboard URL / Account Home)')
	return { id, name: '(entered)' }
}

/**
 * Best-effort zone lookup for the registrable domain of `hostname`. Naively takes the last two
 * dot-labels (e.g. `vozka.example.com` → `example.com`) and queries `GET /zones?name=<domain>`.
 * Returns the zone or null. The wizard WARNS on null (a custom-domain bind needs the zone) but never
 * fails on it — the operator may add the zone before the real deploy.
 */
export async function findZone(token: string, hostname: string): Promise<CfZone | null> {
	const domain = registrableDomain(hostname)
	const response = await fetch(`${CF_API}/zones?name=${encodeURIComponent(domain)}`, { headers: authHeaders(token) })
	const result = await cfJson(response, 'Zone lookup')
	if (!Array.isArray(result) || result.length === 0) {
		return null
	}
	const first = result[0]
	const id = stringProp(first, 'id')
	const name = stringProp(first, 'name')
	if (id !== undefined && name !== undefined) {
		return { id, name }
	}
	return null
}

/** Naive registrable-domain derivation: the last two dot-labels of a hostname. */
function registrableDomain(hostname: string): string {
	const labels = hostname.split('.').filter(Boolean)
	if (labels.length <= 2) {
		return labels.join('.')
	}
	return labels.slice(-2).join('.')
}
