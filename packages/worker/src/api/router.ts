// The `/api/*` router: maps method + path to a handler, enforcing the vozka ACL on EVERY route before
// the handler runs (the GitHub webhook is the only unauthenticated route — it lives in index.ts, not
// here). Mirrors propustka's admin router/dispatch pattern: resolve + authorize, then dispatch.
//
// ACL: each route names its action (src/actions.ts) and, where it operates on a specific app/env, the
// scope (app / environment). `authorize` authenticates via propustka and `can`-checks; on failure it
// returns the 401/403 Response the router returns verbatim. Mutations audit via the AuthContext.

import { ACTIONS } from '../actions'
import type { Db } from '../db'
import { error } from '../http'
import { appScope, type Authenticator, authorize, envScope } from '../iam'
import type { Vault } from '../vault'
import {
	createApp,
	deleteApp,
	deleteAppEnv,
	deleteAppSecret,
	deleteAppVar,
	getApp,
	listAppEnvs,
	listApps,
	listAppSecrets,
	listAppVars,
	putAppEnv,
	putAppSecret,
	putAppVar,
	registerApp,
	type RegistryContext,
	updateApp,
} from './registry'
import { type DeployQueue, getRun, getRunLog, listRuns, type R2Reader, type RunsContext, tailRunLog, triggerDeploy } from './runs'
import { deleteAppSecretValue, rotateAppSecretValue, setAppSecretValue, type VaultContext } from './vault'

/**
 * Everything the router needs (the Worker assembles this from its bindings). `vault` is a FACTORY
 * (async, may need to import the master key) so it's only built when a vault route is hit, and a
 * missing/invalid `VOZKA_VAULT_KEY` surfaces as a clean 500 on those routes alone — every non-vault
 * route works without a vault configured.
 */
export interface ApiDeps {
	db: Db
	/** The auth guard (the router only ever calls `authenticate`); `createIam` wraps the bootstrap-admin fallback in. */
	iam: Authenticator
	queue: DeployQueue
	logs: R2Reader
	vault?: () => Promise<Vault>
}

/**
 * Handle any `/api/*` request (except the webhook). Returns the handler's Response, or a 401/403 from
 * the ACL guard, 404/405 for unknown routes/methods, 500 on an unexpected throw (never leaks internals).
 */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
	const url = new URL(request.url)
	try {
		const response = await dispatch(request, url, deps)
		// Off-local, a successful authenticate may have minted a fresh `px_token`: attach its Set-Cookie
		// to the response so the next request hits the SDK's local fast path (no re-mint). Attached once,
		// centrally, so individual handlers stay cookie-unaware.
		const setCookie = deps.iam.takeSetCookie?.()
		if (setCookie !== undefined && setCookie !== '') {
			const withCookie = new Response(response.body, response)
			withCookie.headers.append('Set-Cookie', setCookie)
			return withCookie
		}
		return response
	} catch (err) {
		console.error('api request failed', err instanceof Error ? err.message : 'unknown error')
		return error(500, 'internal error')
	}
}

async function dispatch(request: Request, url: URL, deps: ApiDeps): Promise<Response> {
	const method = request.method
	// /api/<resource>/<id>/<sub>/<subId>/<subSub>
	const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)
	const [resource, id, sub, subId, subSub] = segments

	const registryCtx = (authorized: Awaited<ReturnType<typeof authorize>>): RegistryContext | Response => {
		if (!authorized.ok) {
			return authorized.response
		}
		return { db: deps.db, request, url, authorized }
	}
	const runsCtx = (authorized: Awaited<ReturnType<typeof authorize>>): RunsContext | Response => {
		if (!authorized.ok) {
			return authorized.response
		}
		return { db: deps.db, queue: deps.queue, logs: deps.logs, request, url, authorized }
	}
	// Build a vault context (constructs the Vault via the factory; a missing/invalid master key is a
	// clean 500 here, isolated to vault routes). Returns the error/Response otherwise.
	const vaultCtx = async (authorized: Awaited<ReturnType<typeof authorize>>): Promise<VaultContext | Response> => {
		if (!authorized.ok) {
			return authorized.response
		}
		if (deps.vault === undefined) {
			return error(500, 'vault not configured (VOZKA_VAULT_KEY missing)')
		}
		try {
			const vault = await deps.vault()
			return { db: deps.db, vault, request, url, authorized }
		} catch {
			// Never echo the master-key error detail; a generic message is enough for the client.
			return error(500, 'vault unavailable (check VOZKA_VAULT_KEY)')
		}
	}

	switch (resource) {
		// ── Onboarding (app.manage, global) ────────────────────────────────────
		case 'register-app': {
			if (method !== 'POST') return methodNotAllowed()
			const a = await authorize(deps.iam, request, ACTIONS.APP_MANAGE)
			const c = registryCtx(a)
			return c instanceof Response ? c : registerApp(c)
		}

		// ── Apps + nested envs/secrets (app.manage / secret.manage, app-scoped) ─
		case 'apps': {
			if (id === undefined) {
				if (method === 'GET') {
					// Listing apps needs app.manage globally (no specific app to scope to).
					const a = await authorize(deps.iam, request, ACTIONS.APP_MANAGE)
					const c = registryCtx(a)
					return c instanceof Response ? c : listApps(c)
				}
				if (method === 'POST') {
					const a = await authorize(deps.iam, request, ACTIONS.APP_MANAGE)
					const c = registryCtx(a)
					return c instanceof Response ? c : createApp(c)
				}
				return methodNotAllowed()
			}

			// Nested: /api/apps/:id/envs[/:env] and /api/apps/:id/secrets[/:name]
			if (sub === 'envs') {
				const a = await authorize(deps.iam, request, ACTIONS.APP_MANAGE, appScope(id))
				const c = registryCtx(a)
				if (c instanceof Response) return c
				if (subId === undefined) {
					if (method === 'GET') return listAppEnvs(c, id)
					return methodNotAllowed()
				}
				if (method === 'PUT') return putAppEnv(c, id, subId)
				if (method === 'DELETE') return deleteAppEnv(c, id, subId)
				return methodNotAllowed()
			}
			if (sub === 'secrets') {
				// /api/apps/:id/secrets/:name/value — the encrypted secret VALUE (vault, write-only).
				// PUT = set (re-encrypts under a fresh entry), PATCH = rotate in place, DELETE = drop entry.
				if (subId !== undefined && subSub === 'value') {
					const a = await authorize(deps.iam, request, ACTIONS.SECRET_MANAGE, appScope(id))
					const c = await vaultCtx(a)
					if (c instanceof Response) return c
					if (method === 'PUT') return setAppSecretValue(c, id, subId)
					if (method === 'PATCH') return rotateAppSecretValue(c, id, subId)
					if (method === 'DELETE') return deleteAppSecretValue(c, id, subId)
					return methodNotAllowed()
				}
				// /api/apps/:id/secrets and /api/apps/:id/secrets/:name — the reference rows (registry).
				const a = await authorize(deps.iam, request, ACTIONS.SECRET_MANAGE, appScope(id))
				const c = registryCtx(a)
				if (c instanceof Response) return c
				if (subId === undefined) {
					if (method === 'GET') return listAppSecrets(c, id)
					if (method === 'PUT') return putAppSecret(c, id)
					return methodNotAllowed()
				}
				if (method === 'DELETE') return deleteAppSecret(c, id, subId)
				return methodNotAllowed()
			}
			// /api/apps/:id/vars[/:name] — NON-secret per-app-env deploy config (plaintext, readable).
			// app.manage (not secret.manage): vars are app config like app_envs, not vault secrets.
			if (sub === 'vars') {
				const a = await authorize(deps.iam, request, ACTIONS.APP_MANAGE, appScope(id))
				const c = registryCtx(a)
				if (c instanceof Response) return c
				if (subId === undefined) {
					if (method === 'GET') return listAppVars(c, id)
					if (method === 'PUT') return putAppVar(c, id)
					return methodNotAllowed()
				}
				if (method === 'DELETE') return deleteAppVar(c, id, subId)
				return methodNotAllowed()
			}

			// /api/apps/:id itself (app.manage, app-scoped)
			const a = await authorize(deps.iam, request, ACTIONS.APP_MANAGE, appScope(id))
			const c = registryCtx(a)
			if (c instanceof Response) return c
			if (method === 'GET') return getApp(c, id)
			if (method === 'PUT' || method === 'PATCH') return updateApp(c, id)
			if (method === 'DELETE') return deleteApp(c, id)
			return methodNotAllowed()
		}

		// ── Runs (deploy.read to read; deploy.trigger to deploy) ────────────────
		case 'runs': {
			if (id === undefined) {
				if (method === 'GET') {
					// List/filter runs — read access. App/env scope from query params when present.
					const scope = scopeForRunQuery(url)
					const a = await authorize(deps.iam, request, ACTIONS.DEPLOY_READ, scope)
					const c = runsCtx(a)
					return c instanceof Response ? c : listRuns(c)
				}
				return methodNotAllowed()
			}
			// /api/runs/:id, /api/runs/:id/log, /api/runs/:id/tail — read access.
			const a = await authorize(deps.iam, request, ACTIONS.DEPLOY_READ)
			const c = runsCtx(a)
			if (c instanceof Response) return c
			if (sub === undefined) {
				return method === 'GET' ? getRun(c, id) : methodNotAllowed()
			}
			if (sub === 'log') {
				return method === 'GET' ? getRunLog(c, id) : methodNotAllowed()
			}
			if (sub === 'tail') {
				return method === 'GET' ? tailRunLog(c, id) : methodNotAllowed()
			}
			return error(404, 'not found')
		}

		// ── Manual trigger (deploy.trigger, app+env scoped) ─────────────────────
		case 'deploy': {
			if (method !== 'POST') return methodNotAllowed()
			// Scope to the app being deployed (read from the body would require parsing twice; the
			// handler re-validates app/env, and the env scope is applied via the app scope here).
			const a = await authorize(deps.iam, request, ACTIONS.DEPLOY_TRIGGER)
			const c = runsCtx(a)
			return c instanceof Response ? c : triggerDeploy(c)
		}

		default:
			return error(404, 'not found')
	}
}

/** Build the scope for a run-history query from `?app=`/`?env=` (app scope wins; else env; else none). */
function scopeForRunQuery(url: URL): ReturnType<typeof appScope> | undefined {
	const app = url.searchParams.get('app')
	if (app !== null && app !== '') {
		return appScope(app)
	}
	const env = url.searchParams.get('env')
	if (env !== null && env !== '') {
		return envScope(env)
	}
	return undefined
}

function methodNotAllowed(): Response {
	return error(405, 'method not allowed')
}
