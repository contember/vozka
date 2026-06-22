import { isRunnerJob, type RunnerJob } from '@vozka/runner'
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from './env'
import { type ContainerLike, type RelayResult, relayRun } from './relay'

export { RunnerContainer } from './RunnerContainer'

/**
 * The vozka control-plane Worker. A single `WorkerEntrypoint` carrying the deploy-run API and
 * (eventually) the dashboard SPA.
 *
 * M2 adds `startRun`: spin up a per-run container, hand it the job, relay its streamed logs +
 * terminal status into R2. Run scheduling, the D1 run schema, and the dashboard are M3 — kept out
 * of here on purpose. `fetch` health-checks, exposes `POST /api/runs`, and otherwise serves assets.
 */
export class Vozka extends WorkerEntrypoint<Env> {
	/**
	 * Start one deploy run: address a fresh container instance for this `runId`, wait for its server
	 * to come up, then relay the job through it (logs + status → R2). Returns the terminal status.
	 *
	 * RPC-callable (service binding) and the body of `POST /api/runs`.
	 */
	async startRun(job: RunnerJob): Promise<RelayResult> {
		const id = this.env.RUNNER.idFromName(job.runId)
		const container = this.env.RUNNER.get(id)
		// Boot the container + its in-container server, then relay. The stub's RPC surface
		// (`containerFetch`, our `heartbeat`) structurally satisfies the relay's `ContainerLike`.
		await container.startAndWaitForPorts()
		const relayable: ContainerLike = {
			containerFetch: (input, init) => container.containerFetch(input, init),
			heartbeat: () => container.heartbeat(),
		}
		return relayRun(relayable, this.env.RUN_LOGS, job)
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/api/health') {
			return Response.json({ status: 'ok', service: 'vozka', milestone: 'M2' })
		}

		if (request.method === 'POST' && url.pathname === '/api/runs') {
			let job: unknown
			try {
				job = await request.json()
			} catch {
				return Response.json({ error: 'invalid JSON body' }, { status: 400 })
			}
			if (!isRunnerJob(job)) {
				return Response.json({ error: 'body is not a valid RunnerJob' }, { status: 400 })
			}
			const result = await this.startRun(job)
			return Response.json(result)
		}

		if (url.pathname.startsWith('/api/')) {
			return new Response('Not implemented until M3', { status: 501 })
		}

		return this.env.ASSETS.fetch(request)
	}
}

export default Vozka
