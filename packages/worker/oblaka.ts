// vozka's OWN infrastructure, authored with oblaka (the same DSL apps use via @vozka/config).
//
// The control-plane Worker binds:
//   - RUNNER       — the per-run deploy container (DO-backed), image = ../runner/Dockerfile, class
//                    `RunnerContainer` (see src/RunnerContainer.ts).
//   - RUN_LOGS     — an R2 bucket the relay writes run logs + terminal status into, keyed by run id.
//   - DB           — D1: the deploy registry (accounts/apps/app_envs/app_secrets) + run history.
//   - DEPLOY_QUEUE — the deploy job queue. Producer (trigger/webhook enqueues a run) + consumer
//                    (queue() handler dequeues → assembles the job → startRun → records the outcome).
//   - IAM          — the propustka IAM Worker (off-local only) for authorization + audit.
//   - ASSETS       — the dashboard SPA (built by @vozka/dashboard, M3b) served for non-API paths.
//
// Run with `bun run oblaka` (dry/plan) or `bun run oblaka:deploy` (remote). The GitHub App secrets
// (GITHUB_WEBHOOK_SECRET / GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY) and the M4 vault key are SECRETS
// provisioned out-of-band (`wrangler secret put` / a `.dev.vars` locally), never placed in `vars`.

import { Container, D1Database, define, Queue, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'

const INSTANCE_TYPE = { local: 'dev', stage: 'basic', prod: 'standard' } as const

export default define(({ env }) => {
	const isLocal = env === 'local'
	const instanceType = env in INSTANCE_TYPE ? INSTANCE_TYPE[env as keyof typeof INSTANCE_TYPE] : 'basic'

	return new Worker({
		dir: '.',
		name: 'vozka',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		observability: { enabled: true },
		assets: {
			directory: '../dashboard/dist',
			binding: 'ASSETS',
			not_found_handling: 'single-page-application',
		},
		vars: {
			ENVIRONMENT: env,
			// Selects the IAM client in src/iam.ts: 'true' (local) → FakeIamClient (no Access, no IAM
			// Worker); '' (off-local) → real IamClient over the IAM binding.
			DEV: isLocal ? 'true' : '',
		},
		bindings: {
			// Per-run deploy-runner container. The DO class lives in src/RunnerContainer.ts and
			// is re-exported from the Worker entry (src/index.ts) so wrangler can find it.
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
})
