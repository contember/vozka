import { describe, expect, test } from 'bun:test'
import { Container, D1Database, R2Bucket, type Worker } from 'vozka-config'
import config, { buildRunnerWorker } from '../../vozka-runner.config'

// vozka-runner's OWN deploy surface (packages/runner/vozka-runner.config.ts) — DOGFOODING vozka-config.
// These tests prove: defineApp accepts it, the resource graph materializes the executor's binding set
// (the RunnerContainer DO + the SHARED, adopted-by-name R2/D1), and it is INFRA — no Access, no schema,
// no runtime secrets. The shared D1 must NOT declare a migrations dir (the control plane owns the schema).

/** Resolve a Worker binding by name (oblaka exposes the materialized graph on `worker.options`). */
function binding(worker: Worker, name: string): unknown {
	return worker.options.bindings?.[name]
}

describe('defineApp(vozka-runner config)', () => {
	test('exports a valid AppConfig with id `vozka-runner` and the worker entry', () => {
		expect(config.id).toBe('vozka-runner')
		const worker = config.resources({ env: 'stage' })
		expect(worker.options.name).toBe('vozka-runner')
		expect(worker.options.main).toBe('./src/worker.ts')
	})

	test('binds the RunnerContainer DO + the shared (adopted) R2 + D1', () => {
		const worker = buildRunnerWorker({ env: 'stage' })
		const container = binding(worker, 'RUNNER')
		expect(container).toBeInstanceOf(Container)
		if (container instanceof Container) {
			expect(container.options.className).toBe('RunnerContainer')
		}
		expect(binding(worker, 'RUN_LOGS')).toBeInstanceOf(R2Bucket)
		expect(binding(worker, 'DB')).toBeInstanceOf(D1Database)
	})

	test('the shared resources keep the control plane names (so oblaka ADOPTS them, not create new)', () => {
		const worker = buildRunnerWorker({ env: 'stage' })
		const logs = binding(worker, 'RUN_LOGS')
		const db = binding(worker, 'DB')
		if (logs instanceof R2Bucket) {
			expect(logs.options.name).toBe('vozka-run-logs')
		}
		if (db instanceof D1Database) {
			expect(db.options.name).toBe('vozka')
			// vozka owns the schema + migrations — vozka-runner only writes the runs row's terminal status.
			expect(db.options.migrationsDir).toBeUndefined()
		}
	})

	test('local builds the container image from the Dockerfile; off-local references the pinned registry image', () => {
		const local = buildRunnerWorker({ env: 'local' })
		const localContainer = binding(local, 'RUNNER')
		if (localContainer instanceof Container) {
			expect(localContainer.options.image).toBe('./Dockerfile')
			expect(localContainer.options.imageBuildContext).toBe('../..')
		}
		const stage = buildRunnerWorker({ env: 'stage' })
		const stageContainer = binding(stage, 'RUNNER')
		if (stageContainer instanceof Container) {
			// Pinned registry ref (image.json has a non-empty tag) — no Dockerfile build, no build context.
			expect(stageContainer.options.image).toContain('registry.cloudflare.com/')
			expect(stageContainer.options.image).toContain('prod-vozka-runner:')
			expect(stageContainer.options.imageBuildContext).toBeUndefined()
		}
	})

	test('it is INFRA: no Access, no schema, no runtime secrets', () => {
		expect(config.access).toBeUndefined()
		expect(config.schema).toBeUndefined()
		expect(config.pipeline?.secrets).toBeUndefined()
		expect(config.pipeline?.workerDir).toBe('.')
	})
})
