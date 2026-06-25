// vozka-runner's OWN deploy surface — the deploy EXECUTOR, split out of the vozka control plane so a
// deploy of vozka never resets the container running that deploy (see src/worker.ts for the why).
//
// vozka-runner is INFRA, not a registered app: no Cloudflare Access front door (it's reachable only via
// vozka's `RUNNER_SVC` service binding, never publicly), no propustka access/schema, no runtime secrets
// (every credential arrives per-run in the `RunnerJob` over the binding). It is deployed RARELY and
// OUT-OF-BAND (scripts/bootstrap-runner.ts) — it can't deploy itself through itself (same self-reset),
// and it only changes when the relay / container / runner image changes.
//
// SHARED RESOURCES: RUN_LOGS (R2) + DB (D1) are the SAME bucket + database the control plane owns. oblaka
// ADOPTS an existing resource by its remote name (`<env>-<name>`), so declaring the same names here binds
// vozka's existing resources rather than creating new ones. vozka owns the schema + migrations; this
// worker only WRITES (run logs/status → R2, the runs row's terminal status → D1) — hence NO migrationsDir.
//
// Local dev still uses oblaka directly via the `oblaka.ts` shim, which calls `buildRunnerWorker` below.

import type { ResourceContext } from 'vozka-config'
import { Container, D1Database, defineApp, R2Bucket, Worker } from 'vozka-config'
import runnerImageManifest from './image.json'

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
 * Build vozka-runner's Cloudflare resource graph for one environment. The SINGLE source of the graph —
 * both the `vozka deploy` / bootstrap path (via `defineApp` below) and the local-dev `oblaka.ts` shim
 * call this, so the two never drift.
 */
export const buildRunnerWorker = (ctx: ResourceContext): Worker => {
	const { env } = ctx
	const isLocal = env === 'local'
	const instanceType = instanceTypeFor(env)

	// The runner image: off-local, reference a pre-built image PINNED in the repo (./image.json, bumped by
	// the runner-image CI workflow on packages/runner|core|config changes) — so a deploy needs NO docker AND
	// the image ref travels WITH the code (like a lockfile; no drift vs a mutable registry var). Local dev
	// builds from the Dockerfile; RUNNER_BUILD=1 forces a Dockerfile build (first bring-up, or a deliberate
	// rebuild on a docker host). The CF registry namespace is the account id.
	const runnerFromDockerfile = isLocal || process.env['RUNNER_BUILD'] === '1' || runnerImageManifest.tag === ''
	const runnerImage = runnerFromDockerfile
		? './Dockerfile'
		: `registry.cloudflare.com/${process.env['CLOUDFLARE_ACCOUNT_ID'] ?? ''}/${runnerImageManifest.image}:${runnerImageManifest.tag}`

	return new Worker({
		dir: '.',
		name: 'vozka-runner',
		main: './src/worker.ts',
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		// No public route — vozka-runner is reachable ONLY via vozka's RUNNER_SVC service binding.
		routes: [],
		observability: { enabled: true },
		vars: {
			ENVIRONMENT: env,
		},
		bindings: {
			// Per-run deploy-runner container. The RunnerContainer DO class lives in src/RunnerContainer.ts
			// and is re-exported from the worker entry (src/worker.ts) so wrangler can find it.
			RUNNER: new Container({
				name: 'vozka-runner',
				className: 'RunnerContainer',
				image: runnerImage,
				// `image_build_context` only applies to a Dockerfile build — it lets the Dockerfile COPY sibling
				// packages (config/core/runner) from the repo ROOT (relative to packages/runner). A pre-built
				// registry image needs no build context, so it's omitted there. (Build context requires oblaka-iac >=0.0.18.)
				...(runnerFromDockerfile ? { imageBuildContext: '../..' } : {}),
				maxInstances: env === 'prod' ? 10 : 3,
				instanceType,
			}),
			// Run logs + terminal status, keyed by run id — the control plane's bucket, ADOPTED by name.
			RUN_LOGS: new R2Bucket({ name: 'vozka-run-logs' }),
			// Registry + run history — the control plane's D1, ADOPTED by name. NO migrationsDir: vozka owns
			// the schema + migrations; vozka-runner only writes the runs row's terminal status.
			DB: new D1Database({ name: 'vozka', locationHint: 'weur' }),
		},
	})
}

export default defineApp({
	id: 'vozka-runner',
	resources: buildRunnerWorker,
	pipeline: {
		// vozka-runner's Worker source lives alongside this config (packages/runner). No build step (no
		// assets), and NO secrets — every credential arrives per-run in the RunnerJob over the binding.
		workerDir: '.',
	},
})
