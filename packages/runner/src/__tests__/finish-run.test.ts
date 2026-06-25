import { describe, expect, test } from 'bun:test'
import { type D1Like, finishRun } from '../finish-run'

// finishRun is vozka-runner's single D1 write — a guarded UPDATE that records a run's terminal status.
// These tests drive it against a fake D1 that captures the query + bindings and reports a `changes`
// count, so we verify the SQL guard + the no-op semantics without a real database.

interface Recorded {
	query: string
	values: unknown[]
}

/** A fake D1 returning a fixed `changes` count and recording the prepared query + bindings. */
const makeDb = (changes: number, rec: Recorded[]): D1Like => ({
	prepare: (query: string) => ({
		bind: (...values: unknown[]) => ({
			run: async () => {
				rec.push({ query, values })
				return { meta: { changes } }
			},
		}),
	}),
})

describe('finishRun', () => {
	test('writes the terminal status guarded on pending|running and reports the transition', async () => {
		const rec: Recorded[] = []
		const did = await finishRun(makeDb(1, rec), 'run-1', 'succeeded', 0)

		expect(did).toBe(true)
		expect(rec).toHaveLength(1)
		// The guard makes a double-write (control plane + vozka-runner) idempotent.
		expect(rec[0]?.query).toContain("status IN ('pending','running')")
		// Bound in order: status, exit code, run id.
		expect(rec[0]?.values).toEqual(['succeeded', 0, 'run-1'])
	})

	test('a no-op (already terminal — the control plane beat us to it) reports false, never throws', async () => {
		const did = await finishRun(makeDb(0, []), 'run-1', 'failed', 1)
		expect(did).toBe(false)
	})

	test('a failed run with no exit code binds null', async () => {
		const rec: Recorded[] = []
		await finishRun(makeDb(1, rec), 'run-2', 'failed', null)
		expect(rec[0]?.values).toEqual(['failed', null, 'run-2'])
	})
})
