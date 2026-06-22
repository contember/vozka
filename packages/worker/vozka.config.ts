// vozka's OWN deploy surface — DOGFOODING `@vozka/config`. vozka is just another app the control
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

import type { AppAccess, AppSchema, ResourceContext } from '@vozka/config'
import { Container, D1Database, defineApp, Queue, R2Bucket, ServiceReference, Worker } from '@vozka/config'
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

	return new Worker({
		dir: '.',
		name: 'vozka',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		observability: { enabled: true },
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
		},
		bindings: {
			// Per-run deploy-runner container. The DO class lives in src/RunnerContainer.ts and is
			// re-exported from the Worker entry (src/index.ts) so wrangler can find it.
			RUNNER: new Container({
				name: 'vozka-runner',
				className: 'RunnerContainer',
				image: '../runner/Dockerfile',
				maxInstances: env === 'prod' ? 10 : 3,
				instanceType,
			}),
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
 *   - operator → `deploy.*`  (trigger + read any deploy; no registry/account/secret management)
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
		{ action: ACTIONS.ACCOUNT_MANAGE, description: 'Manage Cloudflare accounts' },
		{ action: ACTIONS.SECRET_MANAGE, description: 'Manage secret values + their references' },
	],
	roles: {
		operator: {
			name: 'Operator',
			description: 'Trigger and read any deploy (no registry, account, or secret management).',
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
		build: 'bun --filter @vozka/dashboard run build',
		// Runtime Worker secrets vozka needs, provisioned via `wrangler secret put` at deploy:
		//   - VOZKA_VAULT_KEY         — the M4 vault master key (KEK) for the encrypted D1 secret vault.
		//   - GITHUB_APP_PRIVATE_KEY  — the GitHub App PEM key (signs the App JWT for install tokens).
		//   - GITHUB_WEBHOOK_SECRET   — HMAC-verifies inbound POST /webhooks/github.
		// Their VALUES are read from the environment by name at deploy time (never inlined here).
		secrets: ['VOZKA_VAULT_KEY', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'],
	},
})
