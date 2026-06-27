// vozka's OWN deploy surface — DOGFOODING `vozka-config`. vozka is just another app the control
// plane deploys: this single file is the source of truth for vozka's Cloudflare resource graph, its
// authz vocabulary, and its deploy pipeline. vozka gates its own `/api/*` in-process via PropustkaAuth
// (src/iam.ts) — propustka is fully native now, there is no Cloudflare Access front door to reconcile.
// The `vozka deploy` path (packages/core CLI / scripts/bootstrap.ts) loads THIS to self-deploy.
//
// Local dev still uses oblaka directly: `oblaka.ts` is a thin shim that imports `buildVozkaWorker`
// from here and feeds it to oblaka's `define`, so `bunx oblaka oblaka.ts` (wrangler.jsonc generation)
// and `wrangler d1 migrations apply DB --local` keep working unchanged. The resource graph lives in
// ONE place; the two entry points differ only in what surrounds it.
//
// Secrets are never inlined: the GitHub App key/webhook secret + the M4 vault key are declared by
// NAME in `pipeline.secrets` and provisioned out-of-band (`wrangler secret put` / `.dev.vars`).

import type { AppSchema, ResourceContext } from 'vozka-config'
import { D1Database, defineApp, DurableObject, Queue, R2Bucket, ServiceReference, Worker } from 'vozka-config'
import { ACTIONS, SCOPES, VOZKA_APP_ID } from './src/actions'

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

	return new Worker({
		dir: '.',
		name: 'vozka',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		// Bind the public hostname (`ctx.domain` ← VOZKA_DOMAIN) as a Custom Domain — auto-creates the DNS
		// record + cert + route. Declared HERE as IaC so `wrangler deploy` keeps it (a domain attached only
		// in the dashboard gets wiped by the next deploy); PropustkaAuth gates `/api/*` in-process. No
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
			// Selects the auth path in src/iam.ts: 'true' (local) → a synthesized dev-persona AuthContext
			// (no propustka, no IAM Worker); '' (off-local) → PropustkaAuth over the IAM binding.
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
			// Off-local service bindings (local dev has neither): propustka IAM (src/iam.ts uses
			// FakeIamClient locally, DEV='true') + vozka-runner, the deploy executor the queue consumer
			// hands each run to (RUNNER_SVC.startRun). vozka-runner is its OWN worker so a deploy of vozka
			// never resets the container running it — deployed out-of-band (packages/runner bootstrap).
			...(isLocal ? {} : {
				IAM: new ServiceReference('propustka-worker'),
				RUNNER_SVC: new ServiceReference('vozka-runner'),
			}),
		},
	})
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
		//   - PROPUSTKA_PROVISIONING_KEY — vozka's seeded propustka provisioning `px_` key, injected into
		//                               deploys that reconcile schema. Omit at deploy to run without reconcile.
		// Their VALUES are read from the environment by name at deploy time (never inlined here).
		secrets: [
			'VOZKA_VAULT_KEY',
			'GITHUB_APP_PRIVATE_KEY',
			'GITHUB_WEBHOOK_SECRET',
			'CLOUDFLARE_API_TOKEN',
			'PROPUSTKA_PROVISIONING_KEY',
		],
	},
})
