// The per-run container Durable Object. Mirrors the preventado pattern: a subclass of
// `@cloudflare/containers` `Container` whose `defaultPort` matches the in-container server, with a
// generous `sleepAfter` so a long clone + `bun install` + `vozka deploy` is never reaped mid-run.
//
// One DO instance == one container == one run. The vozka-runner Worker addresses a fresh instance per
// run (`idFromName(runId)`), `startAndWaitForPorts()`, then relays the job through it. This DO lives in
// vozka-runner (NOT the vozka control plane) so a deploy of vozka never resets the container that is
// running that very deploy — the self-reset that previously orphaned vozka's own runs.

import { Container } from '@cloudflare/containers'
import { backstopDecision, finishRun, isRunFinished } from './finish-run'
import type { RunnerStatus } from './protocol'
import { RUNNER_PORT } from './protocol'
import { logsKey, statusKey } from './relay'
import type { Env } from './worker-env'

/** First backstop check, ~after a short deploy would normally finish (the relay handles the fast path). */
const BACKSTOP_FIRST_DELAY_S = 90
/** Re-poll interval while a run is still in flight. */
const BACKSTOP_POLL_S = 45
/** Give up after this long (the container is hard-killed ~15 min in) and record the run failed. */
const BACKSTOP_MAX_MS = 18 * 60 * 1000

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

	/**
	 * Arm the run-completion BACKSTOP. The relay (logs → R2, terminal status → D1) runs INSIDE the
	 * `RUNNER_SVC.startRun` RPC from the control plane; when a deploy redeploys vozka ITSELF, vozka's
	 * reset aborts that RPC and kills the relay before it records the outcome — yet this container (a DO
	 * in the SEPARATE vozka-runner worker) survives and the deploy completes. The backstop polls the
	 * container from the DO's own caller-independent context and writes the terminal status if the relay
	 * couldn't. Scheduled via the Container's own `schedule()` (NOT a raw `alarm()` override — the base
	 * class owns the alarm). The write is idempotent (guarded UPDATE), so the relay's fast-path wins when
	 * it survives and the backstop is a cheap no-op.
	 */
	async armBackstop(runId: string): Promise<void> {
		await this.schedule(BACKSTOP_FIRST_DELAY_S, 'backstopCheck', { runId, deadline: Date.now() + BACKSTOP_MAX_MS })
	}

	/** Scheduled backstop tick — records the run's terminal status if the relay didn't. Re-schedules itself while in flight. */
	async backstopCheck(payload: { runId: string; deadline: number }): Promise<void> {
		const { runId, deadline } = payload
		const expired = Date.now() > deadline

		// Read the container's status; null = unreachable (it may have been hard-killed).
		let status: RunnerStatus | null = null
		try {
			const res = await this.containerFetch('http://container/status')
			status = (await res.json()) as RunnerStatus
		} catch {
			status = null
		}

		const action = backstopDecision({ alreadyFinished: await isRunFinished(this.env.DB, runId), status, expired })
		if (action.kind === 'noop') {
			return
		}
		if (action.kind === 'reschedule') {
			await this.schedule(BACKSTOP_POLL_S, 'backstopCheck', { runId, deadline })
			return
		}
		// kind === 'finish': flush whatever the container still holds (best-effort — the relay was cut
		// off mid-stream), then record the terminal status. Never log the error object (it may hold a token).
		if (status !== null) {
			try {
				const logs = await this.containerFetch('http://container/logs')
				const text = await logs.text()
				const lines = text.split('\n').filter((l) => l.length > 0)
				if (lines.length > 0) {
					await this.env.RUN_LOGS.put(logsKey(runId), lines.join('\n'))
				}
				await this.env.RUN_LOGS.put(statusKey(runId), JSON.stringify(status))
			} catch (err) {
				console.error('backstop: final log flush failed', err instanceof Error ? err.message : 'unknown error')
			}
		}
		await finishRun(this.env.DB, runId, action.state, action.exitCode)
	}
}
