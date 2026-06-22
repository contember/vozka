// Tiny formatting helpers shared across pages. Mirrors propustka admin-ui's lib/format.ts.

/**
 * Format an epoch-**seconds** timestamp as a readable local date-time. The control plane stores
 * and returns every timestamp in seconds (SQLite `unixepoch()`), so we scale to millis for `Date`.
 */
export function fmtDate(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) return '—'
	return new Date(seconds * 1000).toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	})
}

/** Format an epoch-**milliseconds** timestamp (log lines carry `ts` in ms) as a local time. */
export function fmtTimeMs(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Human duration between two epoch-seconds stamps (e.g. `1m 12s`); `—` when either is missing. */
export function fmtDuration(startSeconds: number | null | undefined, endSeconds: number | null | undefined): string {
	if (startSeconds === null || startSeconds === undefined || endSeconds === null || endSeconds === undefined) return '—'
	const total = Math.max(0, endSeconds - startSeconds)
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Shorten a commit sha to its first 7 chars; `—` when absent. */
export function shortSha(sha: string | null | undefined): string {
	if (sha === null || sha === undefined || sha === '') return '—'
	return sha.slice(0, 7)
}

/** Drop the `refs/heads/` / `refs/tags/` prefix from a git ref for compact display. */
export function shortRef(ref: string): string {
	return ref.replace(/^refs\/(heads|tags)\//, '')
}

/** Build a query string from an object, skipping empty / undefined / null values. */
export function qs(params: Record<string, string | number | null | undefined>): string {
	const search = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value === null || value === undefined) continue
		const str = String(value).trim()
		if (str === '') continue
		search.set(key, str)
	}
	const out = search.toString()
	return out ? `?${out}` : ''
}
