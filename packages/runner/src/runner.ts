// The in-container run engine — pure of HTTP, so it's unit-testable with a fake command runner.
//
// A `Runner` drives one job through clone → install → `vozka deploy`, narrating progress and
// streaming child stdout/stderr line-by-line into an in-memory log buffer. Secret values and
// credentials are redacted from every line before it lands in the buffer; they only ever reach
// the `vozka` child through its environment, never argv, never a log.

import type { LogLine, RunnerJob, RunnerState, RunnerStatus } from './protocol'

/**
 * Upper bound on the in-memory log replay buffer. A pathologically chatty build (verbose installs,
 * huge generated output) must not exhaust the container's memory. The relay continuously flushes every
 * line to R2, so once a line is persisted it's safe to drop from the in-memory buffer — only a NEW
 * subscriber's replay is bounded, never the durable R2 log.
 */
const MAX_BUFFER_LINES = 10_000

/** A spawned command's outcome plus its (already line-split, redacted) output. */
export interface SpawnResult {
	exitCode: number
}

/** How the runner observes a child process's output, one decoded chunk at a time. */
export interface SpawnHandlers {
	onStdout: (chunk: string) => void
	onStderr: (chunk: string) => void
}

/** A single command to spawn: argv (never a shell string), cwd, and extra env. */
export interface SpawnSpec {
	command: string
	args: string[]
	cwd: string
	env?: Record<string, string>
}

/** Spawns a child process, streaming its output through `handlers`; resolves with the exit code. */
export type Spawner = (spec: SpawnSpec, handlers: SpawnHandlers) => Promise<SpawnResult>

/** The collaborators a `Runner` needs — substituted by tests, defaulted to a real Bun spawn. */
export interface RunnerEnv {
	/** Spawns child processes (git, bun, vozka). */
	spawn: Spawner
	/** Absolute base directory clones are made under (one sub-dir per run). */
	workspace: string
	/** Wall clock, injectable for deterministic tests. Defaults to `Date.now`. */
	now?: () => number
}

/** Build the redactor: a function that masks every sensitive value found in a line. */
const makeRedactor = (job: RunnerJob): (text: string) => string => {
	const sensitive = new Set<string>()
	for (const value of Object.values(job.credentials)) {
		if (typeof value === 'string' && value.length >= 4) {
			sensitive.add(value)
		}
	}
	for (const value of Object.values(job.secrets ?? {})) {
		if (value.length >= 4) {
			sensitive.add(value)
		}
	}
	// Longest-first so a value that contains another is masked before its substring.
	const values = [...sensitive].sort((a, b) => b.length - a.length)
	return (text: string): string => {
		let out = text
		for (const value of values) {
			out = out.split(value).join('***')
		}
		return out
	}
}

/**
 * Drives one job to completion. Construct, subscribe to `onLine` (the Worker relays these to R2),
 * then `await run()`. The terminal `status()` carries the `vozka deploy` exit code.
 */
export class Runner {
	private readonly job: RunnerJob
	private readonly env: Required<RunnerEnv>
	private readonly redact: (text: string) => string
	private readonly buffer: LogLine[] = []
	private readonly subscribers = new Set<(line: LogLine) => void>()
	private state: RunnerState = 'pending'
	private exitCode: number | undefined
	private error: string | undefined
	private readonly startedAt: number
	private finishedAt: number | undefined
	private done = false

	constructor(job: RunnerJob, env: RunnerEnv) {
		this.job = job
		this.env = { now: () => Date.now(), ...env }
		this.redact = makeRedactor(job)
		this.startedAt = this.env.now()
	}

	/** The directory this run's repo is cloned into. */
	get checkoutDir(): string {
		return `${this.env.workspace}/${this.job.runId}`
	}

	/** Append a line (redacted) to the buffer and fan it out to subscribers. */
	private emit(stream: LogLine['stream'], rawText: string): void {
		const text = this.redact(rawText)
		const line: LogLine = { ts: this.env.now(), stream, text }
		this.buffer.push(line)
		if (this.buffer.length > MAX_BUFFER_LINES) {
			// Drop the oldest 10% in one splice (amortized O(1) per line) — those lines are already in R2.
			this.buffer.splice(0, Math.floor(MAX_BUFFER_LINES * 0.1))
		}
		for (const sub of this.subscribers) {
			sub(line)
		}
	}

	/** Split a streamed chunk into lines and emit each (chunks may contain partial trailing text). */
	private emitChunk(stream: 'stdout' | 'stderr', chunk: string): void {
		for (const line of chunk.split('\n')) {
			if (line.length > 0) {
				this.emit(stream, line)
			}
		}
	}

	/** Subscribe to new log lines. Returns an unsubscribe fn. Replay of the buffer is via `lines()`. */
	subscribe(fn: (line: LogLine) => void): () => void {
		this.subscribers.add(fn)
		return () => {
			this.subscribers.delete(fn)
		}
	}

	/** Every line emitted so far (already redacted). */
	lines(): readonly LogLine[] {
		return this.buffer
	}

	/** Whether the run has reached a terminal state. */
	isDone(): boolean {
		return this.done
	}

	/** The current (or terminal) status. */
	status(): RunnerStatus {
		return {
			runId: this.job.runId,
			state: this.state,
			...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
			...(this.error !== undefined ? { error: this.error } : {}),
			startedAt: this.startedAt,
			...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
		}
	}

	/** Spawn a step, wiring its output into the log buffer. */
	private async step(spec: SpawnSpec): Promise<SpawnResult> {
		return this.env.spawn(spec, {
			onStdout: (chunk) => this.emitChunk('stdout', chunk),
			onStderr: (chunk) => this.emitChunk('stderr', chunk),
		})
	}

	/** Build the child env for the `vozka deploy` step: creds + secret values, by name. */
	private deployEnv(): Record<string, string> {
		const env: Record<string, string> = {}
		for (const [key, value] of Object.entries(this.job.credentials)) {
			if (typeof value === 'string' && value.length > 0) {
				env[key] = value
			}
		}
		if (this.job.domain !== undefined) {
			env['VOZKA_DOMAIN'] = this.job.domain
		}
		// Secrets are read by the CLI from the environment by their own name.
		for (const [name, value] of Object.entries(this.job.secrets ?? {})) {
			env[name] = value
		}
		// Non-secret deploy vars: same env-by-name forwarding (the CLI reads pipeline.vars from the env).
		for (const [name, value] of Object.entries(this.job.vars ?? {})) {
			env[name] = value
		}
		return env
	}

	/** Mark the run finished and capture the terminal info. */
	private finish(state: 'succeeded' | 'failed', detail: { exitCode?: number; error?: string } = {}): void {
		this.state = state
		this.exitCode = detail.exitCode
		this.error = detail.error
		this.finishedAt = this.env.now()
		this.done = true
	}

	/**
	 * Run the full pipeline: clone → install → `vozka deploy`. Resolves once terminal (never rejects;
	 * failures land in `status()`). Faithful to M1's CLI: `vozka deploy --env=<env> [--config] [--dry-run]`.
	 */
	async run(): Promise<RunnerStatus> {
		// ── clone ──
		this.state = 'cloning'
		this.emit('meta', `Cloning ${this.job.repoUrl} @ ${this.job.ref}`)
		const clone = await this.step({
			command: 'git',
			args: ['clone', '--depth', '1', '--branch', this.job.ref, this.job.repoUrl, this.checkoutDir],
			cwd: this.env.workspace,
		})
		if (clone.exitCode !== 0) {
			this.emit('meta', `Clone failed (exit ${clone.exitCode})`)
			this.finish('failed', { error: `git clone failed (exit ${clone.exitCode})` })
			return this.status()
		}

		const dir = this.job.workerDir !== undefined ? `${this.checkoutDir}/${this.job.workerDir}` : this.checkoutDir

		// ── install ──
		this.state = 'installing'
		this.emit('meta', `Installing dependencies in ${dir}`)
		const install = await this.step({ command: 'bun', args: ['install'], cwd: dir })
		if (install.exitCode !== 0) {
			this.emit('meta', `Install failed (exit ${install.exitCode})`)
			this.finish('failed', { error: `bun install failed (exit ${install.exitCode})` })
			return this.status()
		}

		// ── deploy ──
		this.state = 'deploying'
		const deployArgs = ['deploy', `--env=${this.job.env}`]
		if (this.job.configPath !== undefined) {
			deployArgs.push(`--config=${this.job.configPath}`)
		}
		if (this.job.dryRun === true) {
			deployArgs.push('--dry-run')
		}
		this.emit('meta', `Running: vozka ${deployArgs.join(' ')}`)
		const deploy = await this.step({ command: 'vozka', args: deployArgs, cwd: dir, env: this.deployEnv() })
		this.emit('meta', `vozka deploy exited with code ${deploy.exitCode}`)
		this.finish(deploy.exitCode === 0 ? 'succeeded' : 'failed', { exitCode: deploy.exitCode })
		return this.status()
	}
}
