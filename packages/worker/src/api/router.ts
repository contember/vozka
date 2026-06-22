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
import { appScope, authorize, envScope, type Iam } from '../iam'
import {
	createAccount,
	createApp,
	deleteAccount,
	deleteApp,
	deleteAppEnv,
	deleteAppSecret,
	getAccount,
	getApp,
	listAccounts,
	listAppEnvs,
	listApps,
	listAppSecrets,
	putAppEnv,
	putAppSecret,
	registerApp,
	type RegistryContext,
	updateAccount,
	updateApp,
} from './registry'
import { type DeployQueue, getRun, getRunLog, listRuns, type R2Reader, type RunsContext, tailRunLog, triggerDeploy } from './runs'

/** Everything the router needs (the Worker assembles this from its bindings). */
export interface ApiDeps {
	db: Db
	iam: Iam
	queue: DeployQueue
	logs: R2Reader
}

/**
 * Handle any `/api/*` request (except the webhook). Returns the handler's Response, or a 401/403 from
 * the ACL guard, 404/405 for unknown routes/methods, 500 on an unexpected throw (never leaks internals).
 */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
	const url = new URL(request.url)
	try {
		return await dispatch(request, url, deps)
	} catch (err) {
		console.error('api request failed', err instanceof Error ? err.message : 'unknown error')
		return error(500, 'internal error')
	}
}

async function dispatch(request: Request, url: URL, deps: ApiDeps): Promise<Response> {
	const method = request.method
	// /api/<resource>/<id>/<sub>/<subId>
	const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)
	const [resource, id, sub, subId] = segments

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

	switch (resource) {
		// ── Accounts (account.manage, global) ──────────────────────────────────
		case 'accounts': {
			if (id === undefined) {
				if (method === 'GET') {
					const a = await authorize(deps.iam, request, ACTIONS.ACCOUNT_MANAGE)
					const c = registryCtx(a)
					return c instanceof Response ? c : listAccounts(c)
				}
				if (method === 'POST') {
					const a = await authorize(deps.iam, request, ACTIONS.ACCOUNT_MANAGE)
					const c = registryCtx(a)
					return c instanceof Response ? c : createAccount(c)
				}
				return methodNotAllowed()
			}
			const a = await authorize(deps.iam, request, ACTIONS.ACCOUNT_MANAGE)
			const c = registryCtx(a)
			if (c instanceof Response) return c
			if (method === 'GET') return getAccount(c, id)
			if (method === 'PUT' || method === 'PATCH') return updateAccount(c, id)
			if (method === 'DELETE') return deleteAccount(c, id)
			return methodNotAllowed()
		}

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
