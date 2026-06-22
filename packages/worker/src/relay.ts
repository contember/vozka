// The Worker→container run relay — the testable core of `startRun`, decoupled from the real DO so
// it can be unit-tested with fakes (no Cloudflare, no Docker).
//
// Given a started container stub and an R2-like bucket, it: POSTs the `RunnerJob` to `/run`, tails
// the `/logs` NDJSON stream relaying every line to R2 (full accumulated log re-flushed under one
// run-keyed object), then polls `/status` for the terminal outcome and persists that too.

import type { LogLine, RunnerJob, RunnerStatus } from '@vozka/runner'

/** The slice of a Cloudflare R2 bucket the relay needs. Real `R2Bucket` satisfies this. */
export interface R2Like {
	put: (key: string, value: string) => Promise<unknown>
}

/** The slice of a started container DO stub the relay needs. `RunnerContainer` satisfies this. */
export interface ContainerLike {
	containerFetch: (input: string, init?: RequestInit) => Promise<Response>
	/** Renew the container's activity timeout (heartbeat) so a quiet long step isn't reaped. */
	heartbeat?: () => Promise<void> | void
}

/** Where a run's artifacts live in R2 (keyed by run id). */
export const logsKey = (runId: string): string => `runs/${runId}/logs.ndjson`
export const statusKey = (runId: string): string => `runs/${runId}/status.json`

/** The relay's outcome: the terminal status (also persisted to R2). */
export interface RelayResult {
	status: RunnerStatus
	/** Total log lines relayed. */
	lineCount: number
}

export interface RelayOptions {
	/** Re-flush the accumulated log to R2 at most this often (ms). Defaults to 2000. */
	flushIntervalMs?: number
	/** Poll `/status` until terminal, at this interval (ms). Defaults to 500. */
	statusPollMs?: number
	/** Clock, injectable for tests. Defaults to `Date.now`. */
	now?: () => number
}

/** Parse a newline-delimited JSON log stream chunk-by-chunk, invoking `onLine` per complete line. */
const streamLines = async (response: Response, onLine: (line: LogLine) => void): Promise<void> => {
	if (response.body === null) {
		return
	}
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let pending = ''
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		pending += decoder.decode(value, { stream: true })
		let newline = pending.indexOf('\n')
		while (newline !== -1) {
			const raw = pending.slice(0, newline)
			pending = pending.slice(newline + 1)
			if (raw.length > 0) {
				onLine(JSON.parse(raw) as LogLine)
			}
			newline = pending.indexOf('\n')
		}
	}
	if (pending.trim().length > 0) {
		onLine(JSON.parse(pending) as LogLine)
	}
}

/**
 * Run the relay against an already-started container. Resolves once the run is terminal, after the
 * final log flush and the status object are persisted to R2.
 */
export const relayRun = async (container: ContainerLike, bucket: R2Like, job: RunnerJob, options: RelayOptions = {}): Promise<RelayResult> => {
	const flushIntervalMs = options.flushIntervalMs ?? 2000
	const statusPollMs = options.statusPollMs ?? 500
	const now = options.now ?? (() => Date.now())

	// Kick off the run.
	const start = await container.containerFetch('http://container/run', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(job),
	})
	if (start.status !== 202) {
		const detail = await start.text().catch(() => '')
		throw new Error(`runner rejected /run: ${start.status} ${detail}`.trim())
	}

	// Tail logs, accumulating the full NDJSON and re-flushing it to R2 periodically.
	const accumulated: string[] = []
	let lastFlush = 0
	let dirty = false
	const flush = async (force: boolean): Promise<void> => {
		if (!dirty && !force) {
			return
		}
		const ts = now()
		if (!force && ts - lastFlush < flushIntervalMs) {
			return
		}
		lastFlush = ts
		dirty = false
		await bucket.put(logsKey(job.runId), accumulated.join('\n'))
	}

	// Heartbeat on a timer so even an output-quiet step (e.g. `bun install`) renews the activity
	// timeout. Each relayed line also heartbeats, covering the common chatty case.
	const heartbeat = (): void => {
		void container.heartbeat?.()
	}
	const heartbeatTimer = setInterval(heartbeat, flushIntervalMs)

	try {
		const logs = await container.containerFetch('http://container/logs')
		await streamLines(logs, (line) => {
			accumulated.push(JSON.stringify(line))
			dirty = true
			heartbeat()
			void flush(false)
		})
	} finally {
		clearInterval(heartbeatTimer)
	}
	// Final log flush once the stream closes (the container closes /logs at terminal state).
	await flush(true)

	// Read the terminal status (poll in case the stream closed a hair before status settled).
	let status: RunnerStatus | undefined
	for (;;) {
		const response = await container.containerFetch('http://container/status')
		const parsed = (await response.json()) as RunnerStatus
		if (parsed.state === 'succeeded' || parsed.state === 'failed') {
			status = parsed
			break
		}
		await new Promise((resolve) => setTimeout(resolve, statusPollMs))
	}

	await bucket.put(statusKey(job.runId), JSON.stringify(status))
	return { status, lineCount: accumulated.length }
}
