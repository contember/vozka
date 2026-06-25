// Typed fetch helper for the vozka control-plane JSON API (`/api/*`), plus the API DTO contract.
//
// Same-origin (`/api/...`), `credentials: 'include'`, JSON in/out. Non-2xx maps to a typed
// `ApiError`. Session-expiry handling mirrors propustka's admin-ui: a Cloudflare Access login
// bounce (opaque/cross-origin redirect, or a 200 that returns HTML instead of JSON) or a 401
// triggers a full `location.reload()` so Access can re-challenge — a SPA fetch can't follow the
// cross-origin Access login page.
//
// The DTO types below are NOT generated and NOT imported from `@vozka/worker` — that package's
// entry (`src/index.ts`) pulls in `cloudflare:workers` and the worker runtime, which can't be
// bundled into a browser SPA, and its handlers return `unknown` (no exported DTO types). So the
// shapes here mirror the `toXDto` mappers in `@vozka/worker/src/api/{registry,runs}.ts` exactly —
// they ARE the contract this SPA consumes. The `LogLine` wire shape is likewise mirrored from
// `@vozka/runner`'s protocol module; we don't import the runner package itself because its entry
// re-exports the in-container server engine (Bun globals), which doesn't type-check in a browser
// build. If `@vozka/runner` ever adds a pure `./protocol` subpath export, swap this for an import.

// ── Run log lines (mirror @vozka/runner protocol LogLine) ───────────────────────

/** One line of run output, as streamed from the container `/logs` and re-served by the worker. */
export interface LogLine {
	/** Epoch ms the line was emitted. */
	ts: number
	/** Which stream it came from. `meta` is the runner's own progress narration. */
	stream: 'stdout' | 'stderr' | 'meta'
	/** The (already secret-redacted) text of the line. */
	text: string
}

// ── Common wrappers ───────────────────────────────────────────────────────────

/** A plain list response (`{ items }`). */
export interface ListResponse<T> {
	items: T[]
}

/** A keyset-paginated list (`{ items, nextCursor }`); `nextCursor` is the `?before=` for the next page. */
export interface CursorList<T> {
	items: T[]
	nextCursor: string | null
}

/**
 * Write-only request to set / rotate an app-secret VALUE in the encrypted vault. The value never comes
 * back out over the API — it goes to the dedicated value endpoint (PUT to set, PATCH to rotate):
 *   - app secret: `PUT|PATCH /apps/:id/secrets/:name/value`
 */
export interface SetSecretValueRequest {
	/** The plaintext value to encrypt + store. Sent once; never returned. */
	value: string
	/** App-secret only: the layer to target. null / omitted = the all-env layer. */
	env?: string | null
}

// ── Apps (mirror toAppDto) ──────────────────────────────────────────────────────

export interface AppDto {
	id: string
	repoUrl: string
	defaultBranch: string
	workerDir: string | null
	buildCmd: string | null
	configPath: string | null
	githubInstallationId: number | null
	createdAt: number
}

/** Optional registry-shaping fields, shared by create/update/register. */
export interface AppOptionalFields {
	defaultBranch?: string
	workerDir?: string | null
	buildCmd?: string | null
	configPath?: string | null
	githubInstallationId?: number | null
}

export interface UpdateAppRequest extends AppOptionalFields {
	repoUrl?: string
}

// ── App environments (mirror toAppEnvDto) ────────────────────────────────────────

export interface AppEnvDto {
	appId: string
	env: string
	domain: string | null
	/** Git ref that triggers a deploy here, e.g. `refs/heads/deploy/prod`. null = manual-only. */
	triggerRef: string | null
	createdAt: number
}

export interface PutAppEnvRequest {
	domain?: string | null
	triggerRef?: string | null
}

// ── App secrets (mirror toAppSecretDto — refs only, values never leave the vault) ──

export interface AppSecretDto {
	appId: string
	/** null = the all-env layer; a string narrows the secret to that env. */
	env: string | null
	name: string
	/** A vault REFERENCE — never the secret value. */
	valueRef: string
	createdAt: number
}

export interface PutAppSecretRequest {
	name: string
	/** A vault reference, never the value. */
	valueRef: string
	/** null / omitted = the all-env layer; a string narrows it to that env. */
	env?: string | null
}

// ── App vars (mirror toAppVarDto — non-secret plaintext config, value IS shown) ──

export interface AppVarDto {
	appId: string
	/** null = the all-env layer; a string narrows the var to that env. */
	env: string | null
	name: string
	/** The plaintext value — vars are non-secret config, so it's readable. */
	value: string
	createdAt: number
}

export interface PutAppVarRequest {
	name: string
	value: string
	/** null / omitted = the all-env layer; a string narrows it to that env. */
	env?: string | null
}

// ── Onboarding (register-app) ────────────────────────────────────────────────────

export interface RegisterAppRequest extends AppOptionalFields {
	id: string
	repoUrl: string
	env: string
	domain?: string | null
	triggerRef?: string | null
}

export interface RegisterAppResponse {
	app: AppDto
	env: AppEnvDto
}

// ── Runs (mirror toRunDto) ───────────────────────────────────────────────────────

export type RunTrigger = 'webhook' | 'manual'
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface RunDto {
	id: string
	appId: string
	env: string
	ref: string
	commitSha: string | null
	trigger: RunTrigger
	status: RunStatus
	exitCode: number | null
	logKey: string | null
	createdAt: number
	startedAt: number | null
	finishedAt: number | null
}

export interface TriggerDeployRequest {
	appId: string
	env: string
	/** Explicit ref; else the env's triggerRef; else the app's default branch. */
	ref?: string
}

/** `GET /api/runs/:id/tail?after=` — the live log slice past a cursor. */
export interface RunTailResponse {
	lines: LogLine[]
	/** Next `?after=` cursor (total line count so far). */
	cursor: number
	/** True once the run is terminal — the poller stops. */
	done: boolean
	/** Run status at the moment of this tail (the relay may settle a hair after the stream closes). */
	status: RunStatus
}

/** `GET /api/runs/:id/log` — the full parsed log (returned `{ lines }`, `status` once a run exists). */
export interface RunLogResponse {
	lines: LogLine[]
	status?: RunStatus
}

// ── Typed fetch ─────────────────────────────────────────────────────────────────

/** A typed non-2xx API failure surfaced to pages / the route error boundary. */
export class ApiError extends Error {
	readonly status: number

	constructor(status: number, message: string) {
		super(message)
		this.name = 'ApiError'
		this.status = status
	}
}

const BASE = '/api'

/** Hard reload so Cloudflare Access re-challenges the (now expired) session. */
function reloadForAccess(): never {
	location.reload()
	// `location.reload()` doesn't actually return; throw to satisfy the type system and stop any
	// further processing while the navigation kicks in.
	throw new ApiError(401, 'Session expired — reloading to re-authenticate.')
}

function looksLikeAccessRedirect(res: Response): boolean {
	// Opaque (cross-origin redirect we couldn't read) — the classic Access bounce.
	if (res.type === 'opaque' || res.type === 'opaqueredirect') return true
	// A 200/30x that returns HTML instead of JSON is the Access login page.
	const contentType = res.headers.get('content-type') ?? ''
	if (res.ok && !contentType.includes('application/json')) return true
	return false
}

async function readError(res: Response): Promise<ApiError> {
	let message = `Request failed (${res.status})`
	try {
		const contentType = res.headers.get('content-type') ?? ''
		if (contentType.includes('application/json')) {
			const body: unknown = await res.json()
			// The worker's `error()` helper returns `{ error: string }`.
			if (body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
				message = body.error
			} else if (body !== null && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
				message = body.message
			}
		} else {
			const text = await res.text()
			if (text.trim().length > 0 && text.length < 500) message = text
		}
	} catch {
		// Keep the default message.
	}
	return new ApiError(res.status, message)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { accept: 'application/json' }
	if (body !== undefined) headers['content-type'] = 'application/json'

	let res: Response
	try {
		res = await fetch(`${BASE}${path}`, {
			method,
			headers,
			credentials: 'include',
			redirect: 'manual',
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : 'Network request failed'
		throw new ApiError(0, message)
	}

	// 401 or an Access login bounce → hard reload to re-challenge.
	if (res.status === 401 || looksLikeAccessRedirect(res)) reloadForAccess()

	if (!res.ok) throw await readError(res)

	// Read the body as text and parse it. An empty body (204 / no content) normalizes to `null` so
	// mutation callers that ignore the result get a defined value. `JSON.parse` returns `any`, so the
	// caller's generic `T` applies at this boundary without a cast.
	const text = await res.text()
	return JSON.parse(text.trim() === '' ? 'null' : text)
}

export const api = {
	get<T>(path: string): Promise<T> {
		return request<T>('GET', path)
	},
	post<T = unknown>(path: string, body?: unknown): Promise<T> {
		return request<T>('POST', path, body ?? {})
	},
	put<T = unknown>(path: string, body?: unknown): Promise<T> {
		return request<T>('PUT', path, body ?? {})
	},
	patch<T = unknown>(path: string, body?: unknown): Promise<T> {
		return request<T>('PATCH', path, body ?? {})
	},
	del<T = unknown>(path: string): Promise<T> {
		return request<T>('DELETE', path)
	},
}
