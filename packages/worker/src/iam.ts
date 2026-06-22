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
import { FakeIamClient, type FakePersona, IamClient, type IamRpc, type Scope } from '@propustka/client'
import { type ACTIONS, SCOPES, VOZKA_APP_ID } from './actions'
import { error } from './http'

/** The shared surface of the real and fake clients (both satisfy it structurally). */
export type Iam = IamClient | FakeIamClient

/** The bindings + vars the IAM factory needs (a subset of the Worker `Env`). */
export interface IamEnv {
	IAM?: IamRpc
	DEV: string
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

/** Build the request-scoped IAM client. Local → persona-backed fake; off-local → real binding. */
export function createIam(env: IamEnv): Iam {
	if (env.DEV) {
		return new FakeIamClient({
			personas: DEV_PERSONAS,
			personaCookie: DEV_PERSONA_COOKIE,
			defaultPersona: DEV_DEFAULT_EMAIL,
		})
	}
	if (!env.IAM) {
		throw new Error(
			'IAM service binding is missing off-local — check the propustka ServiceReference in oblaka.ts and that vozka is behind Cloudflare Access.',
		)
	}
	return new IamClient(env.IAM, VOZKA_APP_ID)
}

/** Scope builders for the two vozka dimensions (src/actions.ts). */
export function appScope(appId: string): Scope {
	return { type: SCOPES.APP, value: appId }
}
export function envScope(env: string): Scope {
	return { type: SCOPES.ENVIRONMENT, value: env }
}

/** The minimal auth surface the guard needs (both IamClient + FakeIamClient satisfy it). */
type Authenticator = Pick<Iam, 'authenticate'>

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
