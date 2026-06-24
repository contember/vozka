// The Worker↔container job protocol — the single source of truth for the wire shapes the
// control-plane Worker (`@vozka/worker`) and the in-container server (`./server.ts`) exchange.
//
// One container handles exactly one run: the Worker `POST`s a `RunnerJob` to `/run`, tails the
// log stream from `/logs`, and polls `/status` for the terminal outcome. Everything here is plain
// JSON over HTTP so the two sides stay decoupled (the container can be exercised with `curl`).

/** Names of the secret values carried in a job. Logged; values live in `RunnerJob.secrets`. */
export type SecretName = string

/**
 * One deploy run, handed to the container. Carries WHAT to deploy (repo + ref + env + workerDir),
 * plus the credentials and secret values the deploy needs. Credentials and secret VALUES are
 * sensitive: the container passes them to the `vozka` child via its environment, never logs them,
 * and never puts them on argv.
 */
export interface RunnerJob {
	/** Stable id of this run (assigned by the control plane); echoed in status + log keys. */
	runId: string
	/** Git remote to clone, e.g. `https://github.com/acme/app.git`. */
	repoUrl: string
	/** Git ref (branch, tag, or commit sha) to check out after cloning. */
	ref: string
	/** Target environment passed to `vozka deploy --env=<env>`. */
	env: string
	/** Sub-directory within the clone the config lives in (relative to repo root). Defaults to `.`. */
	workerDir?: string
	/** Path to the config file relative to `workerDir`. Defaults to `vozka.config.ts`. */
	configPath?: string
	/** Public domain for this stage (becomes `VOZKA_DOMAIN`), when known. */
	domain?: string
	/** Run `vozka deploy --dry-run` (no real Cloudflare/propustka mutation). */
	dryRun?: boolean
	/**
	 * Cloudflare + propustka credentials, injected into the `vozka` child's environment. NEVER
	 * logged, NEVER placed on argv. Only the keys present are forwarded.
	 */
	credentials: {
		CLOUDFLARE_ACCOUNT_ID: string
		CLOUDFLARE_API_TOKEN: string
		PROPUSTKA_URL?: string
		PROPUSTKA_CLIENT_ID?: string
		PROPUSTKA_CLIENT_SECRET?: string
	}
	/**
	 * Secret values the deploy must `wrangler secret put`, keyed by the name the app declares in
	 * `pipeline.secrets`. The CLI reads each by its own name from the environment, so the container
	 * forwards these into the child env. Values are redacted from every log line.
	 */
	secrets?: Record<SecretName, string>
	/**
	 * NON-secret deploy-time config vars, keyed by the name the app declares in `pipeline.vars` (e.g.
	 * propustka's PROPUSTKA_ACCESS_APPS / TEAM). Like secrets, the container forwards them into the child
	 * env so the config reads them via `process.env['NAME']`; UNLIKE secrets they are plaintext config
	 * (not vault-backed, not `wrangler secret put`) and are NOT redacted from logs.
	 */
	vars?: Record<string, string>
}

/** The lifecycle a run moves through inside the container. */
export type RunnerState = 'pending' | 'cloning' | 'installing' | 'deploying' | 'succeeded' | 'failed'

/** The terminal (and in-progress) status the Worker polls from `/status`. */
export interface RunnerStatus {
	/** The run this status is for. */
	runId: string
	/** Current lifecycle phase. */
	state: RunnerState
	/** Process exit code of `vozka deploy`, once the deploy phase has finished. */
	exitCode?: number
	/** Failure detail when `state === 'failed'` before the deploy child even ran (clone/install). */
	error?: string
	/** Epoch ms the run started. */
	startedAt: number
	/** Epoch ms the run reached a terminal state, once it has. */
	finishedAt?: number
}

/** One line of run output, as streamed from `/logs` (newline-delimited JSON). */
export interface LogLine {
	/** Epoch ms the line was emitted. */
	ts: number
	/** Which stream it came from. `meta` is the runner's own progress narration. */
	stream: 'stdout' | 'stderr' | 'meta'
	/** The (already secret-redacted) text of the line. */
	text: string
}

/** Fixed port the in-container server listens on (and the DO's `defaultPort`). */
export const RUNNER_PORT = 8080

/** Health endpoint the DO's `startAndWaitForPorts()` polls. */
export const RUNNER_HEALTH_PATH = '/health'

/**
 * Minimal structural validation that a parsed value is a usable `RunnerJob` — shared by the
 * in-container server (`POST /run`) and the control-plane Worker (`POST /api/runs`) so an untyped
 * JSON body is narrowed without a cast.
 */
export const isRunnerJob = (value: unknown): value is RunnerJob => {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	if (
		!('runId' in value && typeof value.runId === 'string')
		|| !('repoUrl' in value && typeof value.repoUrl === 'string')
		|| !('ref' in value && typeof value.ref === 'string')
		|| !('env' in value && typeof value.env === 'string')
		|| !('credentials' in value && typeof value.credentials === 'object' && value.credentials !== null)
	) {
		return false
	}
	// The two platform creds are mandatory and must be NON-EMPTY: never start a deploy that would only
	// discover a blank account id / token after a clone + install (the deploy would fail mid-run).
	const creds = value.credentials
	return (
		'CLOUDFLARE_ACCOUNT_ID' in creds && typeof creds.CLOUDFLARE_ACCOUNT_ID === 'string' && creds.CLOUDFLARE_ACCOUNT_ID !== ''
		&& 'CLOUDFLARE_API_TOKEN' in creds && typeof creds.CLOUDFLARE_API_TOKEN === 'string' && creds.CLOUDFLARE_API_TOKEN !== ''
	)
}
