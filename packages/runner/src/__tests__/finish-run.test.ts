import { describe, expect, test } from 'bun:test'
import { backstopDecision, type D1Like, finishRun, isRunFinished } from '../finish-run'
import type { RunnerStatus } from '../protocol'

// finishRun is vozka-runner's single D1 write — a guarded UPDATE that records a run's terminal status.
// These tests drive it (and the backstop's pure decision) against fakes — no real database.

interface Recorded {
	query: string
	values: unknown[]
}

/** A fake D1: `run()` reports a fixed `changes`; `first()` returns a fixed row (for isRunFinished). */
const makeDb = (changes: number, rec: Recorded[], firstRow: unknown = null): D1Like => ({
	prepare: (query: string) => ({
		bind: (...values: unknown[]) => ({
			run: async () => {
				rec.push({ query, values })
				return { meta: { changes } }
			},
			first: async <T>() => firstRow as T | null,
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

describe('isRunFinished', () => {
	test('true when a terminal row exists, false when none', async () => {
		expect(await isRunFinished(makeDb(0, [], { status: 'succeeded' }), 'run-1')).toBe(true)
		expect(await isRunFinished(makeDb(0, [], null), 'run-1')).toBe(false)
	})
})

describe('backstopDecision', () => {
	const status = (state: RunnerStatus['state'], exitCode?: number): RunnerStatus => ({
		runId: 'r',
		state,
		startedAt: 1,
		...(exitCode !== undefined ? { exitCode } : {}),
	})

	test('already finished → noop (the relay/control-plane recorded it)', () => {
		expect(backstopDecision({ alreadyFinished: true, status: status('deploying'), expired: false })).toEqual({ kind: 'noop' })
	})

	test('container terminal → finish with its state + exit code', () => {
		expect(backstopDecision({ alreadyFinished: false, status: status('succeeded', 0), expired: false })).toEqual({
			kind: 'finish',
			state: 'succeeded',
			exitCode: 0,
		})
		expect(backstopDecision({ alreadyFinished: false, status: status('failed', 1), expired: false })).toEqual({
			kind: 'finish',
			state: 'failed',
			exitCode: 1,
		})
	})

	test('still in flight before the deadline → reschedule', () => {
		expect(backstopDecision({ alreadyFinished: false, status: status('deploying'), expired: false })).toEqual({ kind: 'reschedule' })
	})

	test('unreachable container before the deadline → reschedule (transient)', () => {
		expect(backstopDecision({ alreadyFinished: false, status: null, expired: false })).toEqual({ kind: 'reschedule' })
	})

	test('past the deadline (in flight OR unreachable) → record failed rather than dangle forever', () => {
		expect(backstopDecision({ alreadyFinished: false, status: status('deploying'), expired: true })).toEqual({
			kind: 'finish',
			state: 'failed',
			exitCode: null,
		})
		expect(backstopDecision({ alreadyFinished: false, status: null, expired: true })).toEqual({ kind: 'finish', state: 'failed', exitCode: null })
	})
})
