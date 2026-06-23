import type { AppConfig } from 'vozka-config'

/**
 * Where a secret lives in the control plane's scoping hierarchy, widest → narrowest:
 *  - 'app'      — scoped to one app, across all its environments.
 *  - 'app-env'  — scoped to one app in one environment (the narrowest, e.g. prod-only keys).
 * Resolution layers narrowest over widest. The vault holds ONLY these app-specific secrets;
 * platform credentials (the CF API token, propustka provisioning creds) are vozka's own Worker
 * secrets (build-time config), never per-app vault entries.
 */
export type SecretScope = 'app' | 'app-env'

/** A reference to a secret in the store — resolved to a value at deploy time, never inlined. */
export interface SecretRef {
	/** The secret's name as the app declares it in `pipeline.secrets`. */
	name: string
	/** The scope this reference resolves against. */
	scope: SecretScope
}

/**
 * Everything the engine needs to deploy one app to one environment: the target coordinates,
 * the Cloudflare + propustka credentials, the resolved secret values, and the working directory
 * the config was loaded from (build commands + relative paths resolve against it).
 */
export interface DeployContext {
	/** Target environment, e.g. `staging` / `production`. */
	env: string
	/** Public domain for this stage, when known. */
	domain?: string
	/** Cloudflare account id to deploy into. */
	accountId: string
	/** Cloudflare API token with deploy permissions. */
	apiToken: string
	/** Base URL of the propustka IAM service, when reconciling access/schema. */
	propustkaUrl?: string
	/** OAuth client id for the propustka admin API. */
	clientId?: string
	/** OAuth client secret for the propustka admin API. */
	clientSecret?: string
	/** Resolved secret values for this deploy, keyed by secret name. */
	secrets: Record<string, string>
	/** Absolute path the config was loaded from; build + relative paths resolve here. */
	cwd: string
	/**
	 * oblaka state KV namespace name — where the deploy's resource state lives in the target account.
	 * Defaults to `<app id>-state` (the per-app convention the legacy `oblaka … --state-namespace=<app>-state`
	 * pipelines used). Per-app so deploys of different apps into the SAME account never collide (oblaka keys
	 * state by env within the namespace), and so a migrated app's first vozka deploy CONTINUES its existing
	 * state instead of re-provisioning. Override only for an app whose existing namespace differs from the default.
	 */
	stateNamespace?: string
	/**
	 * Plan-only mode. When set, the engine builds the plan, runs oblaka with `dryRun:true` (never
	 * `remote`), and SKIPS every real Cloudflare/propustka mutation — `wrangler deploy`,
	 * `wrangler d1 migrations apply`, `wrangler secret put`, and the propustka reconciles — logging
	 * what it WOULD do instead. This is the only way to exercise the full path without real creds.
	 */
	dryRun?: boolean
}

/**
 * One unit of work in a deploy. The engine (M1) materializes a `DeployPlan` of these from the
 * app's config + context, then executes them in order, surfacing each as a `DeployStep`.
 */
export interface JobSpec {
	/** Stable id of the step within a plan. */
	id: string
	/** Coarse kind of work — drives ordering and how the runner reports progress. */
	kind: 'build' | 'provision-resources' | 'migrate' | 'deploy-worker' | 'reconcile-schema' | 'reconcile-access' | 'sync-secrets'
	/** Human-readable description for logs / the dashboard. */
	description: string
	/** Ids of steps that must complete before this one runs. */
	dependsOn?: string[]
}

/** The status of a step or whole run as it moves through the engine. */
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

/** A `JobSpec` plus its live status — what the engine surfaces while executing a plan. */
export interface DeployStep {
	spec: JobSpec
	status: RunStatus
	/** Failure detail when `status === 'failed'`. */
	error?: string
	/** Epoch ms when the step started, once it has. */
	startedAt?: number
	/** Epoch ms when the step finished, once it has. */
	finishedAt?: number
}

/** The full ordered plan the engine computes for one `deploy()` before executing anything. */
export interface DeployPlan {
	/** The app being deployed. */
	appId: string
	/** The target environment. */
	env: string
	/** The ordered steps to execute. */
	steps: JobSpec[]
}

/** The outcome of a `deploy()` call: the plan that ran and the final state of each step. */
export interface DeployResult {
	/** The app that was deployed. */
	appId: string
	/** The environment it was deployed to. */
	env: string
	/** Overall outcome of the run. */
	status: RunStatus
	/** The plan that was executed. */
	plan: DeployPlan
	/** Final state of each step, in execution order. */
	steps: DeployStep[]
}

/** Re-exported for callers that build a `deploy()` invocation. */
export type { AppConfig }
