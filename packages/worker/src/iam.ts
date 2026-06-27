/**
 * IAM client factory + the runtime ACL guard for the control plane.
 *
 * propustka is now the WHOLE front door — native auth, no Cloudflare Access. Each `/api/*` entrypoint
 * calls `authorize(...)` once: it AUTHENTICATES the request via propustka's `PropustkaAuth` (per-path
 * gates + a per-app permission token verified LOCALLY against propustka's JWKS, no per-request RPC),
 * then `can(action, scope?)`-checks against the vozka vocabulary (src/actions.ts). Audit goes through
 * the resolved AuthContext.
 *
 * Two modes, selected by the `DEV` var (set in oblaka.ts):
 *   - local (`DEV='true'`)  → a vozka-synthesized AuthContext from a fixed dev persona (no propustka).
 *   - off-local (`DEV=''`)  → `PropustkaAuth` over the `IAM` binding: a human via SSO (`px_session` →
 *     a minted `px_token`) OR a machine via an `Authorization: Bearer px_` key.
 *
 * The GitHub webhook is the ONLY route that skips this guard (HMAC-gated instead — see index.ts).
 */
import type { AppGates, AuthContext, DomainEvent, FakePersona, IamRpc, PrincipalIdentity, Scope } from '@propustka/client'
import { PropustkaAuth } from '@propustka/client'
import { type ACTIONS, SCOPES, VOZKA_APP_ID } from './actions'
import { error } from './http'

/**
 * The per-path gates vozka's control surface enforces in-process (the propustka-native successor to
 * the deleted Cloudflare Access edge). Every `/api/*` route admits EITHER a machine `px_` key
 * (automation / CI) OR a logged-in human (the dashboard via SSO) — two precedence-ordered rules
 * sharing the glob, exactly like the example app's two-rule gated host. Health, the webhook and the
 * M2 `POST /api/runs` relay are handled BEFORE this guard (index.ts), so they never reach the gates.
 */
const VOZKA_GATES: AppGates = {
	rules: [
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
	],
}

/** vozka's per-request authentication outcome — the dev fake and `PropustkaAuth` both resolve to this. */
export type VozkaAuth =
	| { ok: true; context: AuthContext; setCookie?: string }
	| { ok: false; status: number; reason: string; loginUrl?: string }

/**
 * The request-auth surface every `/api/*` route goes through. `createIam` builds one per request; the
 * router only ever calls `authenticate`. `takeSetCookie` (off-local) hands `handleApi` the freshly
 * minted `px_token` Set-Cookie to attach to the response, so the next request hits the local fast path.
 */
export interface Authenticator {
	authenticate(request: Request): Promise<VozkaAuth>
	takeSetCookie?(): string | undefined
}

/** The bindings + vars the IAM factory needs (a subset of the Worker `Env`). */
export interface IamEnv {
	IAM?: IamRpc
	DEV: string
	/** propustka's origin — the `PropustkaAuth` issuer (token `iss` + the `/auth/login` redirect base). */
	PROPUSTKA_URL?: string
	/**
	 * JSON array of bootstrap-admin emails (normally `'[]'`). A caller whose verified email is listed
	 * here is authorized as admin (`can` → true for every action) even when propustka denies — the
	 * escape hatch for the FIRST operator before propustka knows about vozka (see `withBootstrapAdmins`).
	 */
	VOZKA_BOOTSTRAP_ADMINS?: string
	/**
	 * The seeded propustka provisioning key (a `px_` bearer, also vozka's reconcile credential). A request
	 * bearing it is authorized as a synthetic global-admin — the MACHINE analog of `VOZKA_BOOTSTRAP_ADMINS`
	 * (see `withProvisioningKey`). Empty/unset disables it.
	 */
	PROPUSTKA_PROVISIONING_KEY?: string
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

/** Header (preferred) + cookie the dev persona-switch carries; read by the dev fake. */
export const DEV_PRINCIPAL_HEADER = 'X-Dev-Principal'
export const DEV_PERSONA_COOKIE = 'vozka_dev_principal'
/** Default dev persona (no selector) — the admin, so plain `bun run dev` can click everything. */
export const DEV_DEFAULT_EMAIL = 'admin@vozka.test'

/**
 * DEV-only people directory — the local stand-in for the IAM Worker's principals/grants. Keyed by
 * email (the persona selector the header / cookie carries). Permissions mirror the vozka taxonomy
 * (src/actions.ts):
 *   - admin    → `*`                   (every action, every scope)
 *   - operator → `deploy.*` global     (trigger + read any deploy, no registry mgmt)
 *   - viewer   → `deploy.read` global  (read-only)
 */
const DEV_PERSONAS: Record<string, FakePersona> = {
	'admin@vozka.test': { id: 'mem-admin', label: 'admin@vozka.test', type: 'user', permissions: [{ action: '*', scope: null, source: 'grant' }] },
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

/** Match a vozka permission action pattern against a requested action (`*` / `prefix.*` / exact). */
function actionMatches(pattern: string, action: string): boolean {
	if (pattern === '*') {
		return true
	}
	if (pattern.endsWith('*')) {
		return action.startsWith(pattern.slice(0, -1))
	}
	return pattern === action
}

/**
 * A synthesized AuthContext for a dev persona. The dev fixtures hold GLOBAL grants only (scope null),
 * so `can` is a pure action-pattern match and `scopedTo` is unrestricted (`null`) for any held action;
 * `audit` is a no-op (there is no IAM Worker locally).
 */
function makeDevContext(persona: FakePersona): AuthContext {
	const principal: PrincipalIdentity = { id: persona.id, type: persona.type ?? 'user', label: persona.label }
	const holds = (action: string): boolean => persona.permissions.some((p) => p.scope === null && actionMatches(p.action, action))
	return {
		ok: true,
		principal,
		can: (action, _scope) => holds(action),
		scopedTo: (action, _dimension) => (holds(action) ? null : []),
		audit: () => Promise.resolve(),
	}
}

/** Read the selected dev persona email from the `X-Dev-Principal` header (preferred) or the cookie. */
function readDevPrincipal(request: Request): string | null {
	const header = request.headers.get(DEV_PRINCIPAL_HEADER)
	if (header !== null && header !== '') {
		return header
	}
	const cookie = request.headers.get('cookie') ?? ''
	for (const pair of cookie.split(';')) {
		const [name, ...rest] = pair.trim().split('=')
		if (name === DEV_PERSONA_COOKIE && rest.length > 0) {
			return rest.join('=')
		}
	}
	return null
}

/**
 * The DEV / test authenticator: select a persona by the `X-Dev-Principal` header (or the persona
 * cookie), then synthesize its AuthContext. An UNKNOWN persona email fails (`unknown_principal`, 403)
 * — like the real path, so the bootstrap-admin fallback (which only rescues authenticated USERS) can't
 * lift an unauthenticated caller. No propustka, no IAM Worker.
 */
export function fakeAuthenticator(config: { personas: Record<string, FakePersona>; defaultEmail: string }): Authenticator {
	return {
		authenticate(request: Request): Promise<VozkaAuth> {
			const email = readDevPrincipal(request) ?? config.defaultEmail
			const persona = config.personas[email]
			if (persona === undefined) {
				return Promise.resolve({ ok: false, status: 403, reason: 'unknown_principal' })
			}
			return Promise.resolve({ ok: true, context: makeDevContext(persona) })
		},
	}
}

/** The off-local authenticator: `PropustkaAuth` over the IAM binding (humans via SSO, machines via px_). */
function realAuthenticator(env: IamEnv): Authenticator {
	if (!env.IAM) {
		throw new Error('IAM service binding is missing off-local — check the propustka ServiceReference in oblaka.ts.')
	}
	const issuer = env.PROPUSTKA_URL
	if (issuer === undefined || issuer === '') {
		throw new Error('PROPUSTKA_URL is missing off-local — required as the PropustkaAuth issuer (propustka origin).')
	}
	const auth = new PropustkaAuth(env.IAM, VOZKA_APP_ID, { issuer, gates: VOZKA_GATES })
	let lastSetCookie: string | undefined
	return {
		async authenticate(request: Request): Promise<VozkaAuth> {
			lastSetCookie = undefined
			const result = await auth.authenticate(request)
			if (result.ok) {
				lastSetCookie = result.setCookie
				return { ok: true, context: result.context, ...(result.setCookie !== undefined ? { setCookie: result.setCookie } : {}) }
			}
			return { ok: false, status: result.status, reason: result.reason, ...(result.loginUrl !== undefined ? { loginUrl: result.loginUrl } : {}) }
		},
		takeSetCookie(): string | undefined {
			const cookie = lastSetCookie
			lastSetCookie = undefined
			return cookie
		},
	}
}

/**
 * Build the request-scoped auth guard. Local → persona-backed dev fake; off-local → `PropustkaAuth`.
 * Either way it is wrapped with the bootstrap-admin fallback (`withBootstrapAdmins`): a caller whose
 * verified email is in `VOZKA_BOOTSTRAP_ADMINS` is authorized as admin even if the underlying decision
 * denies, so the first operator can use vozka before propustka knows about it. Empty list → a
 * transparent pass-through.
 */
export function createIam(env: IamEnv): Authenticator {
	const bootstrapAdmins = parseBootstrapAdmins(env.VOZKA_BOOTSTRAP_ADMINS)
	const base = env.DEV ? fakeAuthenticator({ personas: DEV_PERSONAS, defaultEmail: DEV_DEFAULT_EMAIL }) : realAuthenticator(env)
	// The provisioning-key hatch wraps OUTERMOST: a machine bearing the seeded key is admitted as a global
	// admin BEFORE propustka is consulted (its mintFromKey only knows DB-backed credentials, not this
	// env-only bootstrap key), so CI can onboard apps before any admin credential exists.
	return withProvisioningKey(withBootstrapAdmins(base, bootstrapAdmins), (env.PROPUSTKA_PROVISIONING_KEY ?? '').trim())
}

/** The synthetic principal a provisioning-key request resolves to (mirrors propustka's `provisioning-admin`). */
const PROVISIONING_PRINCIPAL: PrincipalIdentity = { id: 'provisioning-admin', type: 'service', label: 'provisioning' }

/** A global-admin AuthContext for the provisioning key: every action allowed, no real grants, no audit sink. */
function makeProvisioningContext(): AuthContext {
	return { ok: true, principal: PROVISIONING_PRINCIPAL, can: () => true, scopedTo: () => null, audit: () => Promise.resolve() }
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
function readBearerToken(header: string | null): string | null {
	if (header === null) {
		return null
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match === null ? null : match[1]
}

/** Constant-time string compare (length-checked) — avoids leaking the provisioning key by timing. */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false
	}
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return diff === 0
}

/**
 * Wrap an authenticator so a request bearing the seeded `PROPUSTKA_PROVISIONING_KEY` is authorized as a
 * synthetic global-admin WITHOUT consulting propustka — the MACHINE analog of the `VOZKA_BOOTSTRAP_ADMINS`
 * human hatch. propustka admits this env-only key on its OWN admin endpoints (`resolveCaller`), but vozka's
 * `/api/*` gate mints a per-app token via `mintFromKey`, which only knows DB-backed credentials — so the
 * control plane recognizes its operator's key HERE, letting CI register + deploy apps before any DB-backed
 * admin credential exists. An empty key → a transparent pass-through (zero overhead in steady state).
 */
export function withProvisioningKey(inner: Authenticator, provisioningKey: string): Authenticator {
	if (provisioningKey === '') {
		return inner
	}
	return {
		authenticate(request: Request): Promise<VozkaAuth> {
			const bearer = readBearerToken(request.headers.get('Authorization'))
			if (bearer !== null && constantTimeEqual(bearer, provisioningKey)) {
				return Promise.resolve({ ok: true, context: makeProvisioningContext() })
			}
			return inner.authenticate(request)
		},
		takeSetCookie: () => inner.takeSetCookie?.(),
	}
}

/**
 * An `AuthContext` whose `can()` always allows (the built-in admin = `*`), wrapping a real context so
 * `principal` / `scopedTo` / `audit` keep delegating to the genuine authenticated identity. Used only
 * for a caller whose verified email is a bootstrap admin — they get full access without any propustka
 * grant. The principal is the REAL one (not synthesized), so audit + row-stamping stay accurate.
 */
class BootstrapAdminAuthContext implements AuthContext {
	readonly ok = true
	readonly principal: PrincipalIdentity | null

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
 * Wrap an authenticator so a caller whose verified USER email (the `principal.label`) is in
 * `bootstrapAdmins` is treated as admin even when the underlying decision would deny. Mirrors
 * propustka's `IAM_BOOTSTRAP_ADMINS`: it matches on the verified email (a service principal, which has
 * no email, is never a bootstrap admin) and grants the built-in `admin` role.
 *
 * Authentication is NOT bypassed — the caller must still authenticate (a failure passes through
 * verbatim). The fallback only overrides the AUTHORIZATION decision. With an empty `bootstrapAdmins`
 * set this returns the authenticator unchanged (zero overhead in steady state).
 */
export function withBootstrapAdmins(inner: Authenticator, bootstrapAdmins: ReadonlySet<string>): Authenticator {
	if (bootstrapAdmins.size === 0) {
		return inner
	}
	return {
		async authenticate(request: Request): Promise<VozkaAuth> {
			const result = await inner.authenticate(request)
			if (!result.ok) {
				// Not authenticated — the bootstrap list can't rescue an unauthenticated caller (no verified
				// email to match). Surface the underlying 401/403 unchanged.
				return result
			}
			// Only a USER principal has an email; its `label` is that email. A service principal's label is
			// the token name — never matched as a bootstrap admin.
			const principal = result.context.principal
			if (principal !== null && principal.type === 'user' && bootstrapAdmins.has(principal.label)) {
				return { ...result, context: new BootstrapAdminAuthContext(result.context) }
			}
			return result
		},
		takeSetCookie: () => inner.takeSetCookie?.(),
	}
}

/** Scope builders for the two vozka dimensions (src/actions.ts). */
export function appScope(appId: string): Scope {
	return { type: SCOPES.APP, value: appId }
}
export function envScope(env: string): Scope {
	return { type: SCOPES.ENVIRONMENT, value: env }
}

/** The authenticated caller, surfaced to handlers so mutations can `auth.audit(...)`. */
export interface Authorized {
	ok: true
	/** The authenticated caller's AuthContext — for `can`-gated handlers to `audit` + stamp rows. */
	auth: AuthContext
}

/**
 * Authenticate the request and check `action` (within optional `scope`). On success returns the
 * `AuthContext` so the handler can `audit`; on failure returns the error `Response` (401 not
 * authenticated, 403 not authorized) the router returns verbatim — a human-gated miss carries the
 * `loginUrl` so the dashboard can bounce the browser to propustka's SSO login. The single enforcement
 * point every API handler calls.
 */
export async function authorize(
	iam: Authenticator,
	request: Request,
	action: (typeof ACTIONS)[keyof typeof ACTIONS],
	scope?: Scope,
): Promise<Authorized | { ok: false; response: Response }> {
	const result = await iam.authenticate(request)
	if (!result.ok) {
		const extra = result.loginUrl !== undefined ? { loginUrl: result.loginUrl } : undefined
		return { ok: false, response: error(result.status, result.reason, extra) }
	}
	if (!result.context.can(action, scope)) {
		return { ok: false, response: error(403, `not authorized: ${action}`) }
	}
	return { ok: true, auth: result.context }
}
