/**
 * Vozka's authorization vocabulary — the action + scope CONSTANTS the runtime enforces.
 *
 * Every API/RPC entrypoint resolves the caller through propustka (`IamClient.authenticate`) and then
 * `auth.can(action, scope?)` against one of these actions, auditing mutations. The GitHub webhook is
 * the only unauthenticated route (HMAC-gated instead).
 *
 * This module is the single source of truth for the strings. The SCHEMA DECLARATION that provisions
 * this vocabulary into propustka (so the admin UI can render real choices) lives in vozka.config.ts —
 * that's M5. Here we only define the constants and enforce them at runtime. Keeping them in one place
 * means the M5 declaration imports the SAME strings the runtime checks against (no drift).
 */

/** The propustka app id vozka authenticates as. */
export const VOZKA_APP_ID = 'vozka'

/**
 * The actions vozka authorizes against. AWS-IAM-style dotted strings; propustka's `permits` matches
 * them (incl. `*` / `prefix.*` wildcards in granted roles).
 */
export const ACTIONS = {
	/** Trigger a deploy run (the manual "Deploy" button / triggerDeploy RPC). Scoped by app/environment. */
	DEPLOY_TRIGGER: 'deploy.trigger',
	/** Read deploy runs + their logs (run history API). Scoped by app/environment. */
	DEPLOY_READ: 'deploy.read',
	/** Manage the app registry (apps + app_envs CRUD, onboarding). Scoped by app (global to create). */
	APP_MANAGE: 'app.manage',
	/** Manage Cloudflare accounts (accounts CRUD). Global (no per-resource scope). */
	ACCOUNT_MANAGE: 'account.manage',
	/**
	 * Manage SECRET VALUES + their references. Gates two things: the app_secrets reference CRUD
	 * (scoped by app) AND writing/rotating/deleting the encrypted VALUES in the M4 vault — both an
	 * app/app-env secret value (app-scoped) and an account's CF API token value (global, no app to
	 * scope to). The value is write-only over the API; it is never returned.
	 */
	SECRET_MANAGE: 'secret.manage',
} as const

export type VozkaAction = (typeof ACTIONS)[keyof typeof ACTIONS]

/**
 * The scope DIMENSIONS vozka authorizes within (flat + independent, propustka semantics):
 *  - `app`         — scoped to one registered app (its `id`), across every environment.
 *  - `environment` — scoped to one environment name (e.g. only `stage`), across apps.
 * A grant with neither scope is global. Callers build a `Scope` with `appScope` / `envScope`.
 */
export const SCOPES = {
	APP: 'app',
	ENVIRONMENT: 'environment',
} as const

export type VozkaScopeType = (typeof SCOPES)[keyof typeof SCOPES]
