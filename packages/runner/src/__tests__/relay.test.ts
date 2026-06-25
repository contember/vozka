import { describe, expect, test } from 'bun:test'
import type { LogLine, RunnerJob, RunnerStatus } from '../protocol'
import { type ContainerLike, logsKey, type R2Like, relayRun, statusKey } from '../relay'

// The relay is the testable core of vozka-runner's `startRun`. These tests drive it against a FAKE
// container (its /run, /logs, /status endpoints) and a FAKE R2 — no Cloudflare, no Docker. This is the
// part of the Worker↔DO path we can verify offline; the real DO + container provisioning is CF-only.

/** An in-memory R2 stand-in capturing the last value written per key. */
class FakeR2 implements R2Like {
	readonly objects = new Map<string, string>()
	async put(key: string, value: string): Promise<void> {
		this.objects.set(key, value)
	}
}

const ndjson = (lines: LogLine[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

const sampleLines: LogLine[] = [
	{ ts: 1, stream: 'meta', text: 'Cloning https://github.com/acme/app.git @ main' },
	{ ts: 2, stream: 'stdout', text: 'bun install: done' },
	{ ts: 3, stream: 'stdout', text: 'sample → stage: succeeded' },
]

/** A fake started container exposing the three protocol endpoints. */
const makeContainer = (status: RunnerStatus, lines: LogLine[], heartbeats: { count: number }): ContainerLike => ({
	heartbeat: () => {
		heartbeats.count++
	},
	containerFetch: async (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input)
		if (init?.method === 'POST' && url.pathname === '/run') {
			return new Response(JSON.stringify({ runId: status.runId, accepted: true }), { status: 202 })
		}
		if (url.pathname === '/logs') {
			return new Response(ndjson(lines), { headers: { 'content-type': 'application/x-ndjson' } })
		}
		if (url.pathname === '/status') {
			return new Response(JSON.stringify(status), { headers: { 'content-type': 'application/json' } })
		}
		return new Response('not found', { status: 404 })
	},
})

const job: RunnerJob = {
	runId: 'run-relay-1',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'main',
	env: 'stage',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'tok' },
}

const terminalStatus: RunnerStatus = { runId: 'run-relay-1', state: 'succeeded', exitCode: 0, startedAt: 1, finishedAt: 9 }

describe('relayRun', () => {
	test('relays the streamed log to R2 and persists terminal status', async () => {
		const bucket = new FakeR2()
		const heartbeats = { count: 0 }
		const container = makeContainer(terminalStatus, sampleLines, heartbeats)

		const result = await relayRun(container, bucket, job, { flushIntervalMs: 0 })

		expect(result.status).toEqual(terminalStatus)
		expect(result.lineCount).toBe(3)

		// Logs landed in R2 under the run-keyed object, as NDJSON.
		const stored = bucket.objects.get(logsKey('run-relay-1'))
		expect(stored).toBeDefined()
		const storedLines = (stored ?? '').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as LogLine)
		expect(storedLines).toHaveLength(3)
		expect(storedLines[2]?.text).toBe('sample → stage: succeeded')

		// Terminal status persisted too.
		const statusObj = JSON.parse(bucket.objects.get(statusKey('run-relay-1')) ?? '{}') as RunnerStatus
		expect(statusObj.state).toBe('succeeded')
		expect(statusObj.exitCode).toBe(0)
	})

	test('heartbeats the container while relaying (long-job keepalive)', async () => {
		const bucket = new FakeR2()
		const heartbeats = { count: 0 }
		const container = makeContainer(terminalStatus, sampleLines, heartbeats)
		await relayRun(container, bucket, job, { flushIntervalMs: 0 })
		// At least one heartbeat per relayed line.
		expect(heartbeats.count).toBeGreaterThanOrEqual(sampleLines.length)
	})

	test('a failed run is relayed faithfully (state failed, exit code preserved)', async () => {
		const bucket = new FakeR2()
		const failed: RunnerStatus = { runId: 'run-relay-1', state: 'failed', exitCode: 1, startedAt: 1, finishedAt: 9 }
		const container = makeContainer(failed, sampleLines, { count: 0 })
		const result = await relayRun(container, bucket, job, { flushIntervalMs: 0 })
		expect(result.status.state).toBe('failed')
		expect(result.status.exitCode).toBe(1)
		expect(JSON.parse(bucket.objects.get(statusKey('run-relay-1')) ?? '{}').state).toBe('failed')
	})

	test('throws when the container rejects /run', async () => {
		const bucket = new FakeR2()
		const container: ContainerLike = {
			containerFetch: async () => new Response('busy', { status: 409 }),
		}
		await expect(relayRun(container, bucket, job)).rejects.toThrow('runner rejected /run')
	})
})
