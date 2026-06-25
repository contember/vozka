/**
 * The vozka-runner Worker's CF bindings. vozka-runner is the deploy EXECUTOR — a worker SEPARATE from
 * the vozka control plane, split out so that deploying vozka itself never resets the Durable Object
 * that is actively running that deploy (the self-reset that orphaned vozka's own runs). vozka calls it
 * over a service binding (`RUNNER_SVC.startRun(job)`); this worker boots the per-run container, relays
 * its logs → R2, and writes the terminal run status → D1 directly — so a run is recorded even if the
 * CALLER (vozka's queue consumer) was reset mid-deploy.
 *
 * RUN_LOGS + DB are the SAME R2 bucket + D1 database the control plane owns (oblaka adopts them by name
 * — vozka-runner declares the same resource names and binds the existing resources; it never creates or
 * migrates them). vozka owns the schema + migrations; vozka-runner only WRITES the runs row's terminal
 * status (a guarded UPDATE — see finish-run.ts) and the run's logs/status objects in R2.
 */
import type { RunnerContainer } from './RunnerContainer'

export interface Env {
	/** Per-run deploy-runner container, backed by the RunnerContainer Durable Object (this worker owns it). */
	RUNNER: DurableObjectNamespace<RunnerContainer>
	/** Run logs + terminal status, keyed by run id (the control plane's bucket, adopted by name). */
	RUN_LOGS: R2Bucket
	/** Registry + run history (the control plane's D1, adopted by name) — vozka-runner only writes terminal run status. */
	DB: D1Database

	// ── Vars ──────────────────────────────────────────────────────────────────
	/** Deploy environment this worker runs in (e.g. `prod`) — for parity with the control plane; diagnostics only. */
	ENVIRONMENT: string
}
