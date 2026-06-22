// vozka's OWN infrastructure, authored with oblaka (the same DSL apps use via @vozka/config).
//
// The control-plane Worker binds:
//   - RUNNER   — the per-run deploy container (DO-backed), image = ../runner/Dockerfile, class
//                `RunnerContainer` (see src/RunnerContainer.ts).
//   - RUN_LOGS — an R2 bucket the relay writes run logs + terminal status into, keyed by run id.
//   - ASSETS   — the dashboard SPA (built by @vozka/dashboard) served for non-/api paths.
//
// Run with `bun run oblaka` (dry/plan) or `bun run oblaka:deploy` (remote). M2 keeps this minimal
// and compiling; the D1 run schema + queues land in M3.

import { Container, define, R2Bucket, Worker } from 'oblaka-iac'

const INSTANCE_TYPE = { local: 'dev', stage: 'basic', prod: 'standard' } as const

export default define(({ env }) => {
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
		},
	})
})
