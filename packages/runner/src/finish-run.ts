// The ONE D1 write vozka-runner makes: move a run to its terminal state (`succeeded` | `failed`),
// stamping the exit code + `finished_at`. vozka-runner writes this DIRECTLY (rather than letting the
// vozka control plane record it after the relay returns) so a run is recorded even when the caller —
// vozka's queue consumer — was reset mid-deploy. That happens precisely for vozka's OWN self-deploy:
// the deploy resets the vozka worker but NOT vozka-runner, so vozka-runner is the one component
// guaranteed to survive to the end of the run and write the outcome.
//
// This deliberately DUPLICATES `@vozka/worker`'s `Db.markRunFinished` (same guarded UPDATE) instead of
// importing it — @vozka/worker depends on @vozka/runner for the wire protocol, so a back-import would
// be a cycle. The control plane owns the `runs` schema + migrations; this is a single, stable column
// write that must stay in sync with that method. Keep the two identical.
//
// The `WHERE status IN ('pending','running')` guard makes the write idempotent and order-independent:
// whichever of vozka-runner / the (possibly still-alive) control plane writes FIRST wins the
// pending|running → terminal transition; the other finds no matching row and is a harmless no-op.

/** The slice of a D1 database this module needs. Real `D1Database` satisfies it. */
export interface D1Like {
	prepare: (query: string) => {
		bind: (...values: unknown[]) => {
			run: () => Promise<{ meta: { changes?: number } }>
		}
	}
}

/**
 * Record a run's terminal outcome. Returns true if THIS call performed the transition (the run was
 * still pending|running), false if it was already terminal (a no-op — the control plane beat us to it).
 * Never throws on a no-op; a thrown D1 error propagates to the caller (logged as a short message).
 */
export const finishRun = async (db: D1Like, runId: string, status: 'succeeded' | 'failed', exitCode: number | null): Promise<boolean> => {
	const result = await db
		.prepare(`UPDATE runs SET status = ?, exit_code = ?, finished_at = unixepoch()
			WHERE id = ? AND status IN ('pending','running')`)
		.bind(status, exitCode, runId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
