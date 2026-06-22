import { describe, expect, test } from 'bun:test'
import type { LogLine, RunnerJob, RunnerStatus } from '../protocol'
import type { RunnerEnv, SpawnHandlers, SpawnResult, SpawnSpec } from '../runner'
import { createServer } from '../server'

// Drive the job protocol through the server's request handler — no real socket. Proves POST /run,
// GET /logs (NDJSON), GET /status, and the 409-on-double-run guard.

const job: RunnerJob = {
	runId: 'run-server-1',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'main',
	env: 'stage',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: 'tok-abcdef' },
	secrets: { SAMPLE_API_KEY: 'super-secret-value' },
	dryRun: true,
}

/** Env whose spawner emits one stdout line per step, all succeeding. */
const makeEnv = (): RunnerEnv => ({
	workspace: '/workspace',
	spawn: async (spec: SpawnSpec, handlers: SpawnHandlers): Promise<SpawnResult> => {
		handlers.onStdout(`output from ${spec.command} with tok-abcdef\n`)
		return { exitCode: 0 }
	},
})

const post = (body: unknown): Request =>
	new Request('http://container/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Wait until the active run reaches a terminal state. */
const waitTerminal = async (server: ReturnType<typeof createServer>): Promise<void> => {
	for (let i = 0; i < 100; i++) {
		const runner = server.current()
		if (runner?.isDone()) {
			return
		}
		await new Promise((r) => setTimeout(r, 5))
	}
	throw new Error('run did not terminate')
}

describe('runner server protocol', () => {
	test('POST /run accepts a job (202) and starts it', async () => {
		const server = createServer(makeEnv())
		const response = await server.handle(post(job))
		expect(response.status).toBe(202)
		const body = (await response.json()) as { runId: string; accepted: boolean }
		expect(body).toEqual({ runId: 'run-server-1', accepted: true })
		expect(server.current()).toBeDefined()
	})

	test('POST /run with invalid body → 400', async () => {
		const server = createServer(makeEnv())
		const response = await server.handle(post({ not: 'a job' }))
		expect(response.status).toBe(400)
	})

	test('a second concurrent /run → 409', async () => {
		const server = createServer({
			workspace: '/workspace',
			// A spawner that never resolves the first step keeps the run in-flight.
			spawn: () => new Promise<SpawnResult>(() => {}),
		})
		expect((await server.handle(post(job))).status).toBe(202)
		expect((await server.handle(post(job))).status).toBe(409)
	})

	test('GET /status reports terminal succeeded + exit 0', async () => {
		const server = createServer(makeEnv())
		await server.handle(post(job))
		await waitTerminal(server)
		const status = (await (await server.handle(new Request('http://container/status'))).json()) as RunnerStatus
		expect(status.state).toBe('succeeded')
		expect(status.exitCode).toBe(0)
		expect(status.runId).toBe('run-server-1')
	})

	test('GET /logs streams redacted NDJSON lines', async () => {
		const server = createServer(makeEnv())
		await server.handle(post(job))
		await waitTerminal(server)
		const text = await (await server.handle(new Request('http://container/logs'))).text()
		const lines = text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as LogLine)
		expect(lines.length).toBeGreaterThan(0)
		// Secret value never leaks into the log stream.
		expect(text).not.toContain('tok-abcdef')
		// Meta narration is present (clone/install/deploy progress).
		expect(lines.some((l) => l.stream === 'meta')).toBe(true)
	})

	test('GET /health → ok', async () => {
		const server = createServer(makeEnv())
		const response = await server.handle(new Request('http://container/health'))
		expect(response.status).toBe(200)
		expect(((await response.json()) as { status: string }).status).toBe('ok')
	})

	test('GET /status before any run → 404', async () => {
		const server = createServer(makeEnv())
		expect((await server.handle(new Request('http://container/status'))).status).toBe(404)
	})
})
