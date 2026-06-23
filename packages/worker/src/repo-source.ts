// The RepoSource abstraction — how the control plane gets a clonable URL for a repo+ref and verifies
// inbound webhooks. Decoupled behind an interface so the queue consumer and webhook handler stay
// testable with a FakeRepoSource (no GitHub, no network), and so a future public-repo direct-clone or
// polling source can slot in.
//
// PUBLIC-REPO DIRECT-CLONE: a public repo needs no token (the clone URL is the repo URL), so
// `clone()` returns the bare URL when no installation id is given. Public repos have no webhook, so
// their deploy trigger is PULLED instead: see `src/repo-poll.ts` (a cron-driven Atom-feed poller), wired
// in `src/index.ts` `scheduled`. Polling lives there (standalone — no webhook HMAC applies to a public
// feed), not as a `RepoSource` method; this interface stays focused on clone + webhook verification.

import { prop, stringField } from './json'

/** The decoded, verified payload of a GitHub `push` webhook (only the fields we use). */
export interface PushEvent {
	/** The pushed git ref, e.g. `refs/heads/deploy/prod`. */
	ref: string
	/** The repo's clone URL (https), used to identify which app this push belongs to. */
	repoUrl: string
	/** The head commit sha after the push, when present. */
	commitSha: string | null
	/** The GitHub App installation id that delivered this event, when present. */
	installationId: number | null
}

/** A clonable git URL plus the ref to check out — what the runner job needs. */
export interface CloneTarget {
	/** The URL to `git clone` (may embed a short-lived token for private repos). */
	cloneUrl: string
	/** The ref to check out after cloning. */
	ref: string
}

/**
 * How the control plane sources a repo. v1 is `GitHubAppRepoSource`; tests use `FakeRepoSource`.
 *  - `clone(repoUrl, ref, installationId?)` → a clonable URL (mints a short-lived token for the
 *    install when one is given; otherwise returns the bare URL for a public repo).
 *  - `verifyWebhook(req)` → the decoded `PushEvent` iff the HMAC signature checks out, else null.
 */
export interface RepoSource {
	clone(repoUrl: string, ref: string, installationId?: number | null): Promise<CloneTarget>
	verifyWebhook(request: Request): Promise<PushEvent | null>
}

// ── HMAC-SHA256 webhook signature verification (shared by real + fake) ─────────

/**
 * Verify a GitHub `X-Hub-Signature-256` header (`sha256=<hex>`) over the raw body using the webhook
 * secret. Constant-time compare via WebCrypto's `verify` (no manual string compare). Returns the raw
 * body string on success so the caller parses it once. `null` on any mismatch / malformed header.
 */
export async function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
	if (signatureHeader === null || !signatureHeader.startsWith('sha256=')) {
		return false
	}
	const provided = hexToBytes(signatureHeader.slice('sha256='.length))
	if (provided === null) {
		return false
	}
	const key = await crypto.subtle.importKey(
		'raw',
		utf8(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	)
	// `crypto.subtle.verify` does the constant-time comparison internally.
	return crypto.subtle.verify('HMAC', key, provided, utf8(rawBody))
}

/**
 * UTF-8 encode a string into an `ArrayBuffer`-backed view. `TextEncoder().encode` is typed
 * `Uint8Array<ArrayBufferLike>`, which doesn't satisfy WebCrypto's `BufferSource` (ArrayBuffer-backed)
 * under the workers-types lib. Copying into a fresh `ArrayBuffer` fixes the type without a cast.
 */
function utf8(text: string): Uint8Array<ArrayBuffer> {
	const encoded = new TextEncoder().encode(text)
	const buffer = new ArrayBuffer(encoded.byteLength)
	const view = new Uint8Array(buffer)
	view.set(encoded)
	return view
}

/** Parse an even-length hex string to bytes; null on any non-hex / odd length. */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
	if (hex.length === 0 || hex.length % 2 !== 0) {
		return null
	}
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) {
		const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
		if (Number.isNaN(byte)) {
			return null
		}
		out[i] = byte
	}
	return out
}

/**
 * Normalize a git repo URL for matching a push against a registered app. Lowercases the host, drops a
 * trailing `.git` and trailing slash, and ignores `https://` vs `git@`/`ssh` differences by reducing
 * to `host/owner/repo`. So `https://github.com/acme/App.git` and `git@github.com:acme/App` match the
 * registered `https://github.com/acme/App`. Same function applied to both sides at write + match time.
 */
export function normalizeRepoUrl(repoUrl: string): string {
	let s = repoUrl.trim()
	// scp-like syntax: git@host:owner/repo → host/owner/repo
	const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(s)
	if (scp) {
		s = `${scp[1]}/${scp[2]}`
	} else {
		// Drop the scheme (https://, ssh://, …) and any leading userinfo (git@…) it carried.
		s = s.replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]+@/, '')
	}
	s = s.replace(/\/+$/, '').replace(/\.git$/i, '')
	const slash = s.indexOf('/')
	if (slash !== -1) {
		s = s.slice(0, slash).toLowerCase() + s.slice(slash)
	}
	return s
}

/** Decode a verified GitHub push payload into our `PushEvent` (structural, no casts). */
export function decodePushEvent(body: unknown, installationFromHeader: number | null): PushEvent | null {
	const ref = stringField(body, 'ref')
	if (ref === undefined) {
		return null
	}
	const repository = prop(body, 'repository')
	const repoUrl = stringField(repository, 'clone_url') ?? stringField(repository, 'html_url')
	if (repoUrl === undefined) {
		return null
	}
	const commitSha = stringField(body, 'after') ?? null
	const installationRaw = prop(prop(body, 'installation'), 'id')
	const installationId = typeof installationRaw === 'number' ? installationRaw : installationFromHeader
	return { ref, repoUrl, commitSha, installationId }
}

// ── GitHubAppRepoSource (v1) ───────────────────────────────────────────────────

export interface GitHubAppConfig {
	/** The GitHub App id (numeric, as a string). */
	appId: string
	/** The GitHub App's PEM private key, used to sign the App JWT. NEVER logged. */
	privateKeyPem: string
	/** The webhook secret used to HMAC-verify inbound deliveries. NEVER logged. */
	webhookSecret: string
	/** Base API URL; override for GitHub Enterprise. Defaults to api.github.com. */
	apiBaseUrl?: string
}

/** Minted installation access token (short-lived) for cloning a private repo. */
interface InstallationToken {
	token: string
	expiresAt: number
}

/**
 * The v1 RepoSource backed by a GitHub App: mints an installation access token to build an
 * authenticated clone URL for a private repo, and HMAC-verifies inbound webhooks. JWT signing uses
 * WebCrypto (RS256). Tokens are never logged and are embedded in the clone URL only at the moment the
 * runner needs them (the URL itself is sensitive — treated like a credential by the runner).
 *
 * NOTE: the actual network calls to GitHub's token endpoint (mint installation token, sign App JWT)
 * run only against the real GitHub API — they're exercised in CF/integration, not unit tests. The
 * pure logic (HMAC verify, ref→env mapping, push decoding) is fully unit-tested via FakeRepoSource +
 * the exported `verifyWebhookSignature` / `decodePushEvent`.
 */
export class GitHubAppRepoSource implements RepoSource {
	private readonly apiBaseUrl: string

	constructor(private readonly config: GitHubAppConfig) {
		this.apiBaseUrl = config.apiBaseUrl ?? 'https://api.github.com'
	}

	async clone(repoUrl: string, ref: string, installationId?: number | null): Promise<CloneTarget> {
		// A public repo (no installation) clones from the bare URL — no token needed.
		if (installationId === undefined || installationId === null) {
			return { cloneUrl: repoUrl, ref }
		}
		const token = await this.mintInstallationToken(installationId)
		// x-access-token is GitHub's documented installation-token clone scheme.
		const url = new URL(repoUrl)
		url.username = 'x-access-token'
		url.password = token.token
		return { cloneUrl: url.toString(), ref }
	}

	async verifyWebhook(request: Request): Promise<PushEvent | null> {
		const rawBody = await request.text()
		const signature = request.headers.get('X-Hub-Signature-256')
		const ok = await verifyWebhookSignature(rawBody, signature, this.config.webhookSecret)
		if (!ok) {
			return null
		}
		let body: unknown
		try {
			body = JSON.parse(rawBody)
		} catch {
			return null
		}
		const installHeader = request.headers.get('X-GitHub-Hook-Installation-Target-ID')
		const installationFromHeader = installHeader !== null && /^\d+$/.test(installHeader) ? Number.parseInt(installHeader, 10) : null
		return decodePushEvent(body, installationFromHeader)
	}

	/**
	 * Mint a short-lived installation access token for cloning. Signs an App JWT (RS256, ≤10 min),
	 * then exchanges it at `/app/installations/:id/access_tokens`. CF/integration only.
	 */
	private async mintInstallationToken(installationId: number): Promise<InstallationToken> {
		const jwt = await this.signAppJwt()
		const response = await fetch(`${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${jwt}`,
				accept: 'application/vnd.github+json',
				'user-agent': 'vozka',
			},
		})
		if (!response.ok) {
			// Never include the response body verbatim — it can echo the (bearer) JWT in error contexts.
			throw new Error(`GitHub installation-token mint failed: ${response.status}`)
		}
		const json: unknown = await response.json()
		const token = stringField(json, 'token')
		const expiresAtStr = stringField(json, 'expires_at')
		if (token === undefined) {
			throw new Error('GitHub installation-token response missing token')
		}
		return { token, expiresAt: expiresAtStr !== undefined ? Date.parse(expiresAtStr) : Date.now() + 60 * 60 * 1000 }
	}

	/** Sign a GitHub App JWT (RS256) valid for ~10 minutes. CF/integration only. */
	private async signAppJwt(): Promise<string> {
		const now = Math.floor(Date.now() / 1000)
		const header = { alg: 'RS256', typ: 'JWT' }
		const payload = { iat: now - 30, exp: now + 9 * 60, iss: this.config.appId }
		const encode = (obj: unknown): string => base64url(utf8(JSON.stringify(obj)))
		const signingInput = `${encode(header)}.${encode(payload)}`
		const key = await crypto.subtle.importKey(
			'pkcs8',
			pemToPkcs8(this.config.privateKeyPem),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['sign'],
		)
		const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(signingInput))
		return `${signingInput}.${base64url(new Uint8Array(signature))}`
	}
}

/** base64url-encode bytes (no padding) — for JWT segments. */
function base64url(bytes: Uint8Array): string {
	let binary = ''
	for (const b of bytes) {
		binary += String.fromCharCode(b)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a PEM PKCS#8 private key body to its DER bytes for `importKey`. */
function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
	const body = pem
		.replace(/-----BEGIN [^-]+-----/, '')
		.replace(/-----END [^-]+-----/, '')
		.replace(/\s+/g, '')
	const binary = atob(body)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i)
	}
	return out
}

// ── FakeRepoSource (tests / local) ─────────────────────────────────────────────

export interface FakeRepoSourceConfig {
	/** Webhook secret to HMAC-verify against (so the verify path is exercised with a real signature). */
	webhookSecret?: string
	/** When set, `clone` embeds this token into the URL (stands in for a minted installation token). */
	fakeToken?: string
}

/**
 * In-memory RepoSource for tests + local dev. `clone` returns the bare URL (or embeds `fakeToken`);
 * `verifyWebhook` runs the SAME real HMAC verification + push decode as the GitHub source, so webhook
 * tests cover the genuine signature check without GitHub.
 */
export class FakeRepoSource implements RepoSource {
	private readonly webhookSecret: string
	private readonly fakeToken: string | undefined

	constructor(config: FakeRepoSourceConfig = {}) {
		this.webhookSecret = config.webhookSecret ?? 'fake-webhook-secret'
		this.fakeToken = config.fakeToken
	}

	clone(repoUrl: string, ref: string, installationId?: number | null): Promise<CloneTarget> {
		if (this.fakeToken !== undefined && installationId !== undefined && installationId !== null) {
			const url = new URL(repoUrl)
			url.username = 'x-access-token'
			url.password = this.fakeToken
			return Promise.resolve({ cloneUrl: url.toString(), ref })
		}
		return Promise.resolve({ cloneUrl: repoUrl, ref })
	}

	async verifyWebhook(request: Request): Promise<PushEvent | null> {
		const rawBody = await request.text()
		const ok = await verifyWebhookSignature(rawBody, request.headers.get('X-Hub-Signature-256'), this.webhookSecret)
		if (!ok) {
			return null
		}
		let body: unknown
		try {
			body = JSON.parse(rawBody)
		} catch {
			return null
		}
		return decodePushEvent(body, null)
	}
}
