import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from './env'

/**
 * The vozka control-plane Worker. A single `WorkerEntrypoint` that will carry both the deploy
 * orchestration API (`/api/*`) and serve the dashboard SPA.
 *
 * M0: skeleton only. `fetch` health-checks and otherwise hands off to the static assets binding.
 * The control plane (run scheduling, the deploy engine over a binding, queues/DO state) is M3.
 */
export class Vozka extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/api/health') {
			return Response.json({ status: 'ok', service: 'vozka', milestone: 'M0' })
		}

		if (url.pathname.startsWith('/api/')) {
			return new Response('Not implemented until M3', { status: 501 })
		}

		return this.env.ASSETS.fetch(request)
	}
}

export default Vozka
