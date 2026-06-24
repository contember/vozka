import type { AppAccess, AppSchema } from '@propustka/core'
import type { Worker } from 'oblaka-iac'

/**
 * The context handed to an app's `resources()` builder when vozka materializes a deploy.
 * It carries the target environment (and optional public domain) so the app can shape its
 * Cloudflare resources per-stage (names, routes, vars). This is the deploy-time analogue of
 * oblaka's `DefineFn` config — vozka owns the lifecycle, the app owns the resource graph.
 */
export interface ResourceContext {
	/** The target environment, e.g. `local` / `staging` / `production`. */
	env: string
	/** The public domain this stage serves on, when known (drives routes/vars). */
	domain?: string
}

/**
 * The pipeline an app's deploy goes through: where its Worker source lives, how to build it,
 * and which secrets must be present. vozka's engine (M1) reads this to drive build + secret
 * provisioning; M0 only declares the shape.
 */
export interface AppPipeline {
	/** Directory containing the Worker source, relative to the config file. Defaults to `.`. */
	workerDir?: string
	/** Shell command run to build the Worker before deploy, e.g. `bun run build`. */
	build?: string
	/** Names of the secrets this app requires at deploy time. */
	secrets?: string[]
	/**
	 * Names of the NON-SECRET deploy-time vars this app needs (e.g. propustka's `PROPUSTKA_ACCESS_APPS`,
	 * `PROPUSTKA_TEAM`). Their values are per-app-env registry config (NOT vault secrets); the engine
	 * injects each into `process.env` BEFORE materializing `resources()`, so a config reads them the same
	 * way a legacy `oblaka.ts` did (`process.env['NAME']`). Use for config that is plaintext but
	 * environment/account-specific — values that don't belong in the committed config. A declared var with
	 * no resolved value is a hard deploy error (never ship a half-configured deploy).
	 */
	vars?: string[]
}

/**
 * An app's full deploy surface, authored in a single `vozka.config.ts`. One config maps to one
 * deployable app across every environment; `resources()` is re-evaluated per environment.
 */
export interface AppConfig {
	/** Stable app id, unique within the control plane. Drives resource naming + propustka app id. */
	id: string
	/** Builds the app's Cloudflare resource graph (an oblaka `Worker`) for a given environment. */
	resources: (ctx: ResourceContext) => Worker
	/** The app's Cloudflare Access edge declaration, reconciled into propustka. */
	access?: AppAccess
	/** The app's authz vocabulary (scopes/actions/roles), reconciled into propustka. */
	schema?: AppSchema
	/** How the app is built and which secrets it needs at deploy time. */
	pipeline?: AppPipeline
}
