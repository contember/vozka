// Live-ish run log viewer. Tails `GET /api/runs/:id/tail?after=<cursor>` on an interval, appending
// the new lines past the cursor it already holds, until the run is terminal (`done: true`). Mirrors
// how the worker re-flushes the whole accumulated NDJSON to one R2 object and serves the slice past
// the cursor (see worker src/api/runs.ts tailRunLog). Each fetch is sequential — a poll never starts
// before the previous one settles — so a slow flush can't pile up overlapping requests.

import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type LogLine, type RunStatus, type RunTailResponse } from '../lib/api'
import { fmtTimeMs } from '../lib/format'

/** Poll interval while a run is live. The relay flushes R2 ~every 2s, so 1.5s keeps it close to live. */
const TAIL_INTERVAL_MS = 1500

interface LogViewProps {
	runId: string
	/** Run status from the loaded run row; seeds whether we begin polling at all. */
	initialStatus: RunStatus
}

function isTerminal(status: RunStatus): boolean {
	return status === 'succeeded' || status === 'failed'
}

export function LogView({ runId, initialStatus }: LogViewProps) {
	const [lines, setLines] = useState<LogLine[]>([])
	const [status, setStatus] = useState<RunStatus>(initialStatus)
	const [error, setError] = useState<string | null>(null)
	const [autoScroll, setAutoScroll] = useState(true)
	const cursorRef = useRef(0)
	const bottomRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		let cancelled = false
		let timer: ReturnType<typeof setTimeout> | undefined

		async function poll() {
			try {
				const res = await api.get<RunTailResponse>(`/runs/${runId}/tail?after=${cursorRef.current}`)
				if (cancelled) return
				if (res.lines.length > 0) {
					setLines((prev) => [...prev, ...res.lines])
				}
				cursorRef.current = res.cursor
				setStatus(res.status)
				setError(null)
				if (res.done || isTerminal(res.status)) {
					return // Terminal — stop polling.
				}
			} catch (cause) {
				if (cancelled) return
				// Transient errors don't abort the tail (we keep retrying); a 403/404 is terminal for this view.
				if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
					setError(cause.message)
					return
				}
				setError(cause instanceof ApiError ? cause.message : 'Lost the log stream — retrying…')
			}
			timer = setTimeout(poll, TAIL_INTERVAL_MS)
		}

		// Always do one fetch (a terminal run still needs its full log rendered once).
		void poll()
		return () => {
			cancelled = true
			if (timer !== undefined) clearTimeout(timer)
		}
	}, [runId])

	// Keep the viewport pinned to the newest line while auto-scroll is on.
	useEffect(() => {
		if (autoScroll) bottomRef.current?.scrollIntoView({ block: 'end' })
	}, [autoScroll])
	useEffect(() => {
		if (autoScroll) bottomRef.current?.scrollIntoView({ block: 'end' })
	})

	const live = !isTerminal(status)

	return (
		<div className="log-view">
			<div className="log-toolbar">
				<span className="muted small">
					{live ? <span className="run-dot" aria-hidden="true" /> : null}
					{live ? 'Streaming…' : 'Log complete'} · {lines.length} {lines.length === 1 ? 'line' : 'lines'}
				</span>
				<label className="checkbox log-autoscroll">
					<input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
					Auto-scroll
				</label>
			</div>
			<div className="log-body">
				{lines.length === 0
					? <div className="log-empty muted">{live ? 'Waiting for output…' : 'No output was captured.'}</div>
					: lines.map((line, i) => (
						<div key={`${line.ts}:${i}`} className={`log-line log-${line.stream}`}>
							<span className="log-ts">{fmtTimeMs(line.ts)}</span>
							<span className="log-text">{line.text}</span>
						</div>
					))}
				<div ref={bottomRef} />
			</div>
			{error && <p className="error-text" role="alert">{error}</p>}
		</div>
	)
}
