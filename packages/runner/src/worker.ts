// The vozka-runner Worker — the deploy EXECUTOR, split out of the vozka control plane.
//
// WHY IT'S SEPARATE: a deploy's final step is `wrangler deploy` of the target worker, run INSIDE the
// per-run container. When the target is vozka itself, that resets vozka's Durable Objects — and the
// container is a DO. So a vozka self-deploy used to reset the very container running it, killing the
// relay and orphaning the run. Hosting the container DO + relay in this SEPARATE worker means a deploy
// of vozka never touches vozka-runner: the container survives, the relay finishes, the status lands.
//
// SURFACE: a single RPC method, `startRun(job)`, invoked by the control plane over a service binding
// (`RUNNER_SVC`). It boots a fresh container for the run, relays its logs → R2, and writes the terminal
// status → D1 itself (the backstop that records the run even if the caller was reset — see finish-run.ts).
// There is no HTTP surface; vozka-runner has no public route and is reachable ONLY via the binding.

import { WorkerEntrypoint } from 'cloudflare:workers'
import { finishRun } from './finish-run'
import type { RunnerJob } from './protocol'
import { type ContainerLike, type RelayResult, relayRun } from './relay'
import type { Env } from './worker-env'

export { RunnerContainer } from './RunnerContainer'

export class VozkaRunner extends WorkerEntrypoint<Env> {
	/**
	 * Execute one deploy run: address a fresh container instance for this `runId`, wait for its server
	 * to come up, relay the job through it (logs + status → R2), then record the terminal status → D1.
	 * Returns the terminal status to the caller — best-effort, since the caller may have been reset
	 * mid-deploy; the D1 write is what guarantees the run is recorded regardless.
	 */
	async startRun(job: RunnerJob): Promise<RelayResult> {
		const id = this.env.RUNNER.idFromName(job.runId)
		const container = this.env.RUNNER.get(id)
		await container.startAndWaitForPorts()
		// Arm the backstop BEFORE the long relay: the container DO will record the terminal status on its
		// own (caller-independent) schedule if this RPC is aborted mid-deploy — which is exactly what a
		// vozka self-deploy does (it resets vozka, killing this RPC). The relay's fast path still wins when
		// it survives; the backstop's write is idempotent (see RunnerContainer.armBackstop / finish-run).
		await container.armBackstop(job.runId)
		const relayable: ContainerLike = {
			containerFetch: (input, init) => container.containerFetch(input, init),
			heartbeat: () => container.heartbeat(),
		}
		const result = await relayRun(relayable, this.env.RUN_LOGS, job)

		// Persist the terminal outcome to D1 directly. The guarded UPDATE is idempotent, so if the
		// control plane is still alive and also records it, whichever writes first wins and the other
		// no-ops. Never log the error object on failure — a job/clone URL could carry a token.
		const state = result.status.state === 'succeeded' ? 'succeeded' : 'failed'
		try {
			await finishRun(this.env.DB, job.runId, state, result.status.exitCode ?? null)
		} catch (err) {
			console.error('vozka-runner: failed to record terminal run status', err instanceof Error ? err.message : 'unknown error')
		}
		return result
	}

	// vozka-runner is RPC-only (invoked via the RUNNER_SVC service binding). It has no public route;
	// a stray direct request just gets a 404 rather than crashing the worker.
	override fetch(): Response {
		return new Response('vozka-runner: rpc only', { status: 404 })
	}
}

export default VozkaRunner
