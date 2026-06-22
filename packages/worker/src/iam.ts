/**
 * IAM client factory + the runtime ACL guard for the control plane.
 *
 * Vozka delegates AUTHENTICATION to Cloudflare Access at the edge and AUTHORIZATION + AUDIT to the
 * propustka IAM Worker over the `IAM` service binding. App code never talks to D1 for auth, never
 * validates JWTs: each API/RPC entrypoint calls `authorize(...)` once, which `authenticate`s the
 * caller and then `can(action, scope?)`s against the vozka vocabulary (src/actions.ts).
 *
 * Two modes, selected by the `DEV` var (set in oblaka.ts), exactly like poplach's app/iam.ts:
 *   - local (`DEV='true'`)  → `FakeIamClient` in PERSONA mode (a fixed set of dev personas).
 *   - off-local (`DEV=''`)  → real `IamClient` over `env.IAM`.
 *
 * The GitHub webhook is the ONLY route that skips this guard (HMAC-gated instead — see index.ts).
 */
import type { AuthContext, AuthFailure, DomainEvent, PrincipalIdentity } from '@propustka/client'
import { FakeIamClient, type FakePersona, IamClient, type IamRpc, type Scope } from '@propustka/client'
import { type ACTIONS, SCOPES, VOZKA_APP_ID } from './actions'
import { error } from './http'

/** The shared surface of the real and fake clients (both satisfy it structurally). */
export type Iam = IamClient | FakeIamClient

/** The bindings + vars the IAM factory needs (a subset of the Worker `Env`). */
export interface IamEnv {
	IAM?: IamRpc
	DEV: string
	/**
	 * JSON array of bootstrap-admin emails (normally `'[]'`). A caller whose verified email is listed
	 * here is authorized as admin (`can` → true for every action) even when propustka denies — the
	 * escape hatch for the FIRST operator before propustka knows about vozka (see `withBootstrapAdmins`).
	 */
	VOZKA_BOOTSTRAP_ADMINS?: string
}

/**
 * Parse the `VOZKA_BOOTSTRAP_ADMINS` JSON array into a set of emails. Mirrors propustka's
 * `parseBootstrapAdmins` semantics: a malformed / non-array value fails CLOSED (empty set), so a bad
 * env var grants nobody admin. An empty / unset value (the steady state) yields an empty set.
 */
export function parseBootstrapAdmins(raw: string | undefined): ReadonlySet<string> {
	if (raw === undefined || raw.trim() === '') {
		return new Set()
	}
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) {
			return new Set()
		}
		return new Set(parsed.filter((v): v is string => typeof v === 'string'))
	} catch {
		return new Set()
	}
}

/** Cookie the dev persona-switch sets; read by the fake. */
export const DEV_PERSONA_COOKIE = 'vozka_dev_principal'
/** Default dev persona (no cookie) — the admin, so plain `bun run dev` can click everything. */
export const DEV_DEFAULT_EMAIL = 'admin@vozka.test'

/**
 * DEV-only people directory + grant fixture — the local stand-in for the IAM Worker's
 * principals/grants. Keyed by email (the persona key the cookie carries). Permissions mirror the
 * vozka taxonomy (src/actions.ts):
 *   - admin   → `*`                              (every action, every scope)
 *   - operator → `deploy.*` global               (trigger + read any deploy, no registry mgmt)
 *   - viewer   → `deploy.read` global            (read-only)
 */
const DEV_PERSONAS: Record<string, FakePersona> = {
	'admin@vozka.test': {
		id: 'mem-admin',
		label: 'admin@vozka.test',
		type: 'user',
		permissions: [{ action: '*', scope: null, source: 'grant' }],
	},
	'operator@vozka.test': {
		id: 'mem-operator',
		label: 'operator@vozka.test',
		type: 'user',
		permissions: [{ action: 'deploy.*', scope: null, source: 'grant' }],
	},
	'viewer@vozka.test': {
		id: 'mem-viewer',
		label: 'viewer@vozka.test',
		type: 'user',
		permissions: [{ action: 'deploy.read', scope: null, source: 'grant' }],
	},
}

/**
 * Build the request-scoped IAM client. Local → persona-backed fake; off-local → real binding. Either
 * way it is wrapped with the bootstrap-admin fallback (`withBootstrapAdmins`): a caller whose verified
 * email is in `VOZKA_BOOTSTRAP_ADMINS` is authorized as admin even if the underlying client denies, so
 * the first operator can use vozka before propustka knows about it. With an empty list (the steady
 * state) the wrapper is a transparent pass-through.
 */
export function createIam(env: IamEnv): Authenticator {
	const bootstrapAdmins = parseBootstrapAdmins(env.VOZKA_BOOTSTRAP_ADMINS)
	if (env.DEV) {
		return withBootstrapAdmins(
			new FakeIamClient({
				personas: DEV_PERSONAS,
				personaCookie: DEV_PERSONA_COOKIE,
				defaultPersona: DEV_DEFAULT_EMAIL,
			}),
			bootstrapAdmins,
		)
	}
	if (!env.IAM) {
		throw new Error(
			'IAM service binding is missing off-local — check the propustka ServiceReference in oblaka.ts and that vozka is behind Cloudflare Access.',
		)
	}
	return withBootstrapAdmins(new IamClient(env.IAM, VOZKA_APP_ID), bootstrapAdmins)
}

/**
 * An `AuthContext` whose `can()` always allows (the built-in admin = `*`), wrapping a real context so
 * `principal` / `scopedTo` / `audit` keep delegating to the genuine authenticated identity. Used only
 * for a caller whose verified email is a bootstrap admin — they get full access without any propustka
 * grant. The principal is the REAL one (not synthesized), so audit + row-stamping stay accurate.
 */
class BootstrapAdminAuthContext implements AuthContext {
	readonly ok = true
	readonly principal: PrincipalIdentity

	constructor(private readonly inner: AuthContext) {
		this.principal = inner.principal
	}

	can(_action: string, _scope?: Scope): boolean {
		// Bootstrap admin = the built-in global `admin` role — every action, every scope.
		return true
	}

	scopedTo(action: string, dimension: string): string[] | null {
		// Unrestricted (admin) — null means "holds the action globally" (see AuthContext.scopedTo).
		return this.inner.scopedTo(action, dimension)
	}

	audit(event: DomainEvent): Promise<void> {
		return this.inner.audit(event)
	}
}

/**
 * Wrap an IAM client so a caller whose verified USER email (the `principal.label`) is in
 * `bootstrapAdmins` is treated as admin even when the underlying client would deny. Mirrors
 * propustka's `IAM_BOOTSTRAP_ADMINS`: it matches on the EDGE-verified email (a service principal,
 * which has no email, is never a bootstrap admin) and grants the built-in `admin` role.
 *
 * Authentication is NOT bypassed — the caller must still pass Cloudflare Access / authenticate
 * (a failure passes through verbatim). The fallback only overrides the AUTHORIZATION decision. With
 * an empty `bootstrapAdmins` set this returns the client unchanged (zero overhead in steady state).
 */
export function withBootstrapAdmins(client: Authenticator, bootstrapAdmins: ReadonlySet<string>): Authenticator {
	if (bootstrapAdmins.size === 0) {
		return client
	}
	return {
		async authenticate(request: Request): Promise<AuthContext | AuthFailure> {
			const auth = await client.authenticate(request)
			if (!auth.ok) {
				// Not authenticated — the bootstrap list can't rescue an unauthenticated caller (we have
				// no verified email to match). Surface the underlying 401/403 unchanged.
				return auth
			}
			// Only a USER principal has an email; its `label` is that email (PrincipalIdentity). A
			// service principal's label is the token name — never matched as a bootstrap admin.
			if (auth.principal.type === 'user' && bootstrapAdmins.has(auth.principal.label)) {
				return new BootstrapAdminAuthContext(auth)
			}
			return auth
		},
	}
}

/** Scope builders for the two vozka dimensions (src/actions.ts). */
export function appScope(appId: string): Scope {
	return { type: SCOPES.APP, value: appId }
}
export function envScope(env: string): Scope {
	return { type: SCOPES.ENVIRONMENT, value: env }
}

/**
 * The minimal auth surface the guard needs (both IamClient + FakeIamClient satisfy it, as does the
 * `withBootstrapAdmins` wrapper). `createIam` returns this — the router only ever calls `authenticate`.
 */
export type Authenticator = Pick<Iam, 'authenticate'>

/** The authenticated caller, surfaced to handlers so mutations can `auth.audit(...)`. */
export interface Authorized {
	ok: true
	auth: Awaited<ReturnType<Iam['authenticate']>> & { ok: true }
}

/**
 * Authenticate the request and check `action` (within optional `scope`). On success returns the
 * `AuthContext` so the handler can `audit`; on failure returns the error `Response` (401 not
 * authenticated, 403 not authorized) the entrypoint returns verbatim. The single enforcement point
 * every API/RPC handler calls — exactly like propustka apps gate on `can()`.
 */
export async function authorize(
	iam: Authenticator,
	request: Request,
	action: (typeof ACTIONS)[keyof typeof ACTIONS],
	scope?: Scope,
): Promise<Authorized | { ok: false; response: Response }> {
	const auth = await iam.authenticate(request)
	if (!auth.ok) {
		return { ok: false, response: error(auth.status, auth.reason) }
	}
	if (!auth.can(action, scope)) {
		return { ok: false, response: error(403, `not authorized: ${action}`) }
	}
	return { ok: true, auth }
}
