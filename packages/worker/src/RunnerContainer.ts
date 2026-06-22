// The per-run container Durable Object. Mirrors the preventado pattern: a subclass of
// `@cloudflare/containers` `Container` whose `defaultPort` matches the in-container server, with a
// generous `sleepAfter` so a long clone + `bun install` + `vozka deploy` is never reaped mid-run.
//
// One DO instance == one container == one run. The control-plane Worker addresses a fresh instance
// per run (`idFromName(runId)`), `startAndWaitForPorts()`, then relays the job through it.

import { Container } from '@cloudflare/containers'
import { RUNNER_PORT } from '@vozka/runner'
import type { Env } from './env'

export class RunnerContainer extends Container<Env> {
	// Must match the in-container Bun server's fixed port (and the oblaka Container image's EXPOSE).
	override defaultPort = RUNNER_PORT

	// Heartbeat / long-job safety: a deploy run (clone + install + deploy) can take many minutes,
	// and a quiet `bun install` produces no traffic. A long inactivity window keeps the instance
	// from being reaped; the relay additionally calls `heartbeat()` to renew the timer (see below).
	// CF still SIGTERMs on a rollout and hard-kills ~15 min later — runs are expected to finish well
	// inside that, and the control plane records terminal status from R2 regardless.
	override sleepAfter = '20m'

	override onStart(): void {
		console.info('vozka runner container started')
	}

	override onStop(params: { exitCode: number; reason: string }): void {
		console.info(`vozka runner container stopped (exit ${params.exitCode}, ${params.reason})`)
	}

	override onError(error: unknown): void {
		console.error('vozka runner container error:', error)
	}

	/**
	 * Renew the activity timeout. The relay calls this on each log line and on a timer so a long,
	 * output-quiet step (e.g. `bun install`) doesn't let the inactivity timer trip mid-run.
	 */
	heartbeat(): void {
		this.renewActivityTimeout()
	}
}
