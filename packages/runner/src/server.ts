// The in-container HTTP server implementing the job protocol. One container = one run:
//
//   POST /run      — accept a `RunnerJob`, kick off the pipeline (clone → install → vozka deploy).
//   GET  /logs     — replay the log buffer then stream new lines live (newline-delimited JSON),
//                    closing once the run is terminal.
//   GET  /status   — the current `RunnerStatus` (`{ state, exitCode, ... }`).
//   GET  /health   — readiness probe (what the DO's `startAndWaitForPorts()` polls).
//
// Secrets/credentials arrive in the POST body and are forwarded to the `vozka` child via env only;
// they are never echoed back and (via the Runner) never reach a log line verbatim.

import type { LogLine } from './protocol'
import { isRunnerJob, RUNNER_HEALTH_PATH, RUNNER_PORT } from './protocol'
import { Runner, type RunnerEnv } from './runner'

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Serialize one log line as a newline-delimited JSON record. */
const encodeLine = (line: LogLine): Uint8Array => new TextEncoder().encode(`${JSON.stringify(line)}\n`)

export interface RunnerServer {
	/** Handle one request — exposed so tests can drive the protocol without a real socket. */
	handle: (request: Request) => Promise<Response>
	/** The active runner, once `/run` has been called (for tests / introspection). */
	current: () => Runner | undefined
}

/**
 * Build the request handler over an injected `RunnerEnv` (spawner + workspace). The process holds at
 * most one run; a second `POST /run` while one is active is rejected with 409.
 */
export const createServer = (env: RunnerEnv): RunnerServer => {
	let runner: Runner | undefined

	const handleRun = async (request: Request): Promise<Response> => {
		if (runner !== undefined && !runner.isDone()) {
			return json({ error: 'a run is already in progress' }, 409)
		}
		let body: unknown
		try {
			body = await request.json()
		} catch {
			return json({ error: 'invalid JSON body' }, 400)
		}
		if (!isRunnerJob(body)) {
			return json({ error: 'body is not a valid RunnerJob' }, 400)
		}
		const active = new Runner(body, env)
		runner = active
		// Kick off the pipeline; the client tails /logs and polls /status. Errors are captured into
		// status() by Runner.run(), so this never rejects.
		void active.run()
		return json({ runId: body.runId, accepted: true }, 202)
	}

	const handleLogs = (): Response => {
		const active = runner
		if (active === undefined) {
			return json({ error: 'no run started' }, 404)
		}
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// Replay everything buffered so far.
				for (const line of active.lines()) {
					controller.enqueue(encodeLine(line))
				}
				if (active.isDone()) {
					controller.close()
					return
				}
				// Then stream new lines live; close when the run reaches a terminal state.
				const unsubscribe = active.subscribe((line) => {
					try {
						controller.enqueue(encodeLine(line))
					} catch {
						unsubscribe()
					}
				})
				const poll = setInterval(() => {
					if (active.isDone()) {
						clearInterval(poll)
						unsubscribe()
						try {
							controller.close()
						} catch {
							// already closed
						}
					}
				}, 100)
			},
		})
		return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
	}

	const handle = async (request: Request): Promise<Response> => {
		const url = new URL(request.url)
		if (request.method === 'POST' && url.pathname === '/run') {
			return handleRun(request)
		}
		if (request.method === 'GET' && url.pathname === '/logs') {
			return handleLogs()
		}
		if (request.method === 'GET' && url.pathname === '/status') {
			return runner === undefined ? json({ error: 'no run started' }, 404) : json(runner.status())
		}
		if (request.method === 'GET' && url.pathname === RUNNER_HEALTH_PATH) {
			return json({ status: 'ok', port: RUNNER_PORT })
		}
		return json({ error: 'not found' }, 404)
	}

	return { handle, current: () => runner }
}
