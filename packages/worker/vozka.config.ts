// vozka's OWN deploy surface — DOGFOODING `vozka-config`. vozka is just another app the control
// plane deploys: this single file is the source of truth for vozka's Cloudflare resource graph, its
// Cloudflare Access front door, its authz vocabulary, and its deploy pipeline. The `vozka deploy`
// path (packages/core CLI / scripts/bootstrap.ts) loads THIS to self-deploy.
//
// Local dev still uses oblaka directly: `oblaka.ts` is a thin shim that imports `buildVozkaWorker`
// from here and feeds it to oblaka's `define`, so `bunx oblaka oblaka.ts` (wrangler.jsonc generation)
// and `wrangler d1 migrations apply DB --local` keep working unchanged. The resource graph lives in
// ONE place; the two entry points differ only in what surrounds it.
//
// Secrets are never inlined: the GitHub App key/webhook secret + the M4 vault key are declared by
// NAME in `pipeline.secrets` and provisioned out-of-band (`wrangler secret put` / `.dev.vars`).

import type { AppAccess, AppSchema, ResourceContext } from 'vozka-config'
import { Container, D1Database, defineApp, DurableObject, Queue, R2Bucket, ServiceReference, Worker } from 'vozka-config'
import { ACTIONS, SCOPES, VOZKA_APP_ID } from './src/actions'

/** Container instance type per stage — dev locally, larger off-local; any other env → basic. */
const instanceTypeFor = (env: string): 'dev' | 'basic' | 'standard' => {
	if (env === 'local') {
		return 'dev'
	}
	if (env === 'prod') {
		return 'standard'
	}
	return 'basic'
}

/**
 * Build vozka's full Cloudflare resource graph for one environment. This is the SINGLE source of the
 * graph — consolidated out of the old `oblaka.ts`. Both the `vozka deploy` path (via `defineApp`
 * below) and the local-dev `oblaka.ts` shim call this, so the two never drift.
 *
 * `ctx.domain` (from `VOZKA_DOMAIN` on the `vozka deploy` path) is surfaced as a runtime var so the
 * Worker can build absolute URLs (e.g. webhook callbacks); it's empty locally, where oblaka's
 * `define` has no domain to pass.
 */
export const buildVozkaWorker = (ctx: ResourceContext): Worker => {
	const { env, domain } = ctx
	const isLocal = env === 'local'
	const instanceType = instanceTypeFor(env)

	// The runner image: reference a pre-built image by registry URI (RUNNER_IMAGE — set by the
	// runner-image CI job after it builds + pushes) so a deploy THROUGH the runner needs NO local docker;
	// fall back to the Dockerfile for local dev + the bootstrap break-glass path (which runs on a docker host).
	const runnerImage = process.env['RUNNER_IMAGE'] ?? '../runner/Dockerfile'
	const runnerFromDockerfile = runnerImage.endsWith('Dockerfile')

	return new Worker({
		dir: '.',
		name: 'vozka',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		// Bind the public hostname (`ctx.domain` ← VOZKA_DOMAIN) as a Custom Domain — auto-creates the DNS
		// record + cert + route. Declared HERE as IaC so `wrangler deploy` keeps it (a domain attached only
		// in the dashboard gets wiped by the next deploy); propustka's reconciled Access app fronts it. No
		// domain (local-dev oblaka shim) → no route → *.workers.dev.
		routes: domain !== undefined && domain !== '' ? [{ pattern: domain, custom_domain: true }] : [],
		observability: { enabled: true },
		// Cron trigger driving `scheduled` (src/index.ts): poll PUBLIC repos (no GitHub App install)
		// for new commits every 5 minutes — the pull-based deploy trigger alongside the push webhook.
		triggers: { crons: ['*/5 * * * *'] },
		assets: {
			// The dashboard SPA (built by @vozka/dashboard, M3b) served for non-API paths.
			directory: '../dashboard/dist',
			binding: 'ASSETS',
			not_found_handling: 'single-page-application',
		},
		vars: {
			ENVIRONMENT: env,
			// The public domain this stage serves on (drives absolute URLs); empty when unknown.
			VOZKA_DOMAIN: domain ?? '',
			// Selects the IAM client in src/iam.ts: 'true' (local) → FakeIamClient (no Access, no IAM
			// Worker); '' (off-local) → real IamClient over the IAM binding.
			DEV: isLocal ? 'true' : '',
			// Bootstrap-admin fallback (src/iam.ts): a JSON array of emails authorized as admin even
			// when propustka denies / the IAM binding isn't wired yet. Empty by default; the bootstrap
			// script (scripts/bootstrap.ts) sets the first operator's email here for initial bring-up.
			VOZKA_BOOTSTRAP_ADMINS: process.env['VOZKA_BOOTSTRAP_ADMINS'] ?? '[]',
			// The SINGLE Cloudflare account vozka deploys every app into (single-account; not secret),
			// and the propustka coords every deploy reconciles against. Surfaced from the deploy env (the
			// CLI/bootstrap always set them); the running Worker injects them into every RunnerJob.
			CLOUDFLARE_ACCOUNT_ID: process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '',
			PROPUSTKA_URL: process.env['PROPUSTKA_URL'] ?? '',
			// The GitHub App's numeric id (public, not a secret) — it's the `iss` of the App JWT that mints
			// installation tokens to clone PRIVATE app repos. The PEM key is a `pipeline.secret`; the id is
			// just config, so it rides as a var. Without it the JWT iss is empty and GitHub answers 401.
			GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
		},
		bindings: {
			// Per-run deploy-runner container. The DO class lives in src/RunnerContainer.ts and is
			// re-exported from the Worker entry (src/index.ts) so wrangler can find it.
			RUNNER: new Container({
				name: 'vozka-runner',
				className: 'RunnerContainer',
				image: runnerImage,
				// `image_build_context` only applies to a Dockerfile build — it lets the Dockerfile COPY sibling
				// packages (config/core/runner) from the repo ROOT (relative to packages/worker). A pre-built
				// registry image needs no build context, so it's omitted there. (Build context requires oblaka-iac >=0.0.18.)
				...(runnerFromDockerfile ? { imageBuildContext: '../..' } : {}),
				maxInstances: env === 'prod' ? 10 : 3,
				instanceType,
			}),
			// Per-app-env deploy lock — serializes deploys of the same (app, env) so two triggers can't
			// race on cf-state / wrangler / propustka. DO class in src/DeployLock.ts, re-exported from the
			// Worker entry (src/index.ts) so wrangler finds it.
			DEPLOY_LOCK: new DurableObject({ name: 'vozka-deploy-lock', className: 'DeployLock' }),
			// Run logs + terminal status, keyed by run id (runs/<id>/logs.ndjson, runs/<id>/status.json).
			RUN_LOGS: new R2Bucket({ name: 'vozka-run-logs' }),
			// Registry + run history. D1 is region-specific → pinned to EU West. Migrations in ./migrations.
			DB: new D1Database({ name: 'vozka', migrationsDir: './migrations', locationHint: 'weur' }),
			// Deploy job queue: producer (POST /webhooks/github + triggerDeploy) + consumer (queue()).
			// A run is enqueued by id; the consumer loads it from D1, assembles the job, and runs it.
			DEPLOY_QUEUE: new Queue({
				name: 'vozka-deploy',
				binding: 'both',
				consumer: {
					// One deploy at a time per message; a deploy is long, so a small batch + generous
					// retry budget. The lifecycle consumer is idempotent (status-guarded), so a redeliver
					// is a safe no-op.
					maxBatchSize: 1,
					maxRetries: 3,
					retryDelay: 30,
				},
			}),
			// propustka IAM (off-local only). Locally src/iam.ts uses FakeIamClient (DEV='true').
			...(isLocal ? {} : { IAM: new ServiceReference('propustka-worker') }),
		},
	})
}

/**
 * vozka's Cloudflare Access front door, reconciled into propustka. Mirrors poplach's two-app shape:
 * one gated operator host (machines via service tokens + humans), plus a PUBLIC bypass carve-out for
 * the ONE unauthenticated route — `POST /webhooks/github` — which is HMAC-gated in the Worker, not
 * Access-gated. WHO the humans are is propustka's central HUMAN_EMAIL_DOMAINS/HUMAN_EMAILS (not here).
 *
 * `destinations` are the production hostname, from `VOZKA_DOMAIN`. reconcile only USES them when
 * CREATING a missing CF app; for an existing app it preserves the destinations and changes only the
 * policies — so re-running never re-routes a live app.
 *
 * Why NOT throw at import when VOZKA_DOMAIN is unset (unlike propustka/poplach's access files): this
 * config is imported by BOTH the deploy path (CLI / scripts/bootstrap.ts — which always set
 * VOZKA_DOMAIN) AND the local-dev `oblaka.ts` shim (which has no domain and never reconciles access).
 * A throw would break `bunx oblaka oblaka.ts`. Instead the deploy paths require VOZKA_DOMAIN at the
 * boundary (the CLI/bootstrap fail loudly without it), and the `reconcile-access` step only runs when
 * `propustkaUrl` is set — so the placeholder host below is never reconciled anywhere real.
 */
const buildAccess = (): AppAccess => {
	// `VOZKA_DOMAIN.invalid` is an unreconcilable placeholder for the no-domain import paths (local-dev
	// oblaka); the real reconcile (CLI/bootstrap) always has the genuine host in process.env.
	const host = process.env['VOZKA_DOMAIN'] ?? 'unset.vozka.invalid'
	return {
		apps: [
			{
				// The gated control plane: operators in a browser (humans) + machines (service tokens).
				key: 'operator',
				name: VOZKA_APP_ID,
				destinations: [host],
				sessionDuration: '24h',
				rules: [{ kind: 'service-auth' }, { kind: 'human' }],
			},
			{
				// Public carve-out: ONLY the GitHub webhook ingest. GitHub posts here with no Access
				// identity; the Worker HMAC-verifies it (src/webhook.ts). Nothing else is public.
				key: 'webhook',
				name: `${VOZKA_APP_ID}-webhook`,
				destinations: [`${host}/webhooks/github`],
				rules: [{ kind: 'public' }],
			},
		],
	}
}

/**
 * vozka's authz vocabulary, reconciled into propustka so the admin UI can render real choices. Kept
 * in sync with the runtime by importing the SAME constants the Worker enforces against (src/actions.ts)
 * — the action strings and scope dimensions here are exactly what `auth.can(action, scope)` checks.
 *
 * Roles (origin='app'):
 *   - operator → `deploy.*`  (trigger + read any deploy; no registry/secret management)
 *   - admin    → `*`         (every action, every scope)
 */
const schema: AppSchema = {
	// The two scope dimensions vozka authorizes within (flat + independent — see src/actions.ts).
	scopes: [
		{ type: SCOPES.APP, label: 'App' },
		{ type: SCOPES.ENVIRONMENT, label: 'Environment' },
	],
	// The concrete actions vozka enforces — imported from src/actions.ts so there is no drift.
	actions: [
		{ action: ACTIONS.DEPLOY_TRIGGER, description: 'Trigger a deploy run' },
		{ action: ACTIONS.DEPLOY_READ, description: 'Read deploy runs + their logs' },
		{ action: ACTIONS.APP_MANAGE, description: 'Manage the app registry (apps + app_envs)' },
		{ action: ACTIONS.SECRET_MANAGE, description: 'Manage secret values + their references' },
	],
	roles: {
		operator: {
			name: 'Operator',
			description: 'Trigger and read any deploy (no registry or secret management).',
			// `deploy.*` covers deploy.trigger + deploy.read (prefix wildcard).
			permissions: ['deploy.*'],
		},
		admin: {
			name: 'Admin',
			description: 'Full access to every vozka action in every scope.',
			permissions: ['*'],
		},
	},
}

export default defineApp({
	id: VOZKA_APP_ID,
	resources: buildVozkaWorker,
	access: buildAccess(),
	schema,
	pipeline: {
		// vozka's Worker source lives alongside this config (packages/worker).
		workerDir: '.',
		// Build the dashboard SPA into ../dashboard/dist (the ASSETS directory) before deploy.
		build: 'bun run --filter @vozka/dashboard build',
		// Runtime Worker secrets vozka needs, provisioned via `wrangler secret put` at deploy:
		//   - VOZKA_VAULT_KEY         — the M4 vault master key (KEK) for the encrypted D1 secret vault.
		//   - GITHUB_APP_PRIVATE_KEY  — the GitHub App PEM key (signs the App JWT for install tokens).
		//   - GITHUB_WEBHOOK_SECRET   — HMAC-verifies inbound POST /webhooks/github.
		//   - CLOUDFLARE_API_TOKEN    — the account-wide CF token vozka deploys every app with (single
		//                               account → one token; same token that authenticated THIS deploy).
		//   - PROPUSTKA_CLIENT_ID/SECRET — vozka's propustka provisioning key, injected into deploys that
		//                               reconcile schema/access. Omit at deploy to run without reconcile.
		// Their VALUES are read from the environment by name at deploy time (never inlined here).
		secrets: [
			'VOZKA_VAULT_KEY',
			'GITHUB_APP_PRIVATE_KEY',
			'GITHUB_WEBHOOK_SECRET',
			'CLOUDFLARE_API_TOKEN',
			'PROPUSTKA_CLIENT_ID',
			'PROPUSTKA_CLIENT_SECRET',
		],
	},
})
