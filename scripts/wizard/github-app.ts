/**
 * GitHub App creation via the MANIFEST FLOW — the wizard's centerpiece. Instead of hand-creating an
 * App in the GitHub UI and copying a dozen fields, we POST a manifest to GitHub, the operator clicks
 * "Create", GitHub redirects back to a tiny local server with a one-time `code`, and we exchange it
 * for the App's id + PEM private key + webhook secret in one call. See:
 *   https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 *
 * The returned `pem` and `webhookSecret` are SECRET — this module returns them to the caller (which
 * routes them into the bootstrap child env) but never logs them. Only the App's id / slug / html_url
 * are non-secret and safe to print.
 */

import { randomBytes } from 'node:crypto'
import { action, detail, info, ok, url } from './log'
import { numberProp, stringProp } from './narrow'

/** What the manifest conversion yields. `pem` + `webhookSecret` are secrets; the rest are public. */
export interface CreatedGitHubApp {
	id: number
	slug: string
	htmlUrl: string
	pem: string
	webhookSecret: string
}

interface ManifestInput {
	org: string
	appName: string
	vozkaDomain: string
	/** Public App — required when it will be installed on repos OUTSIDE its owner org (cross-org). GitHub
	 *  only lets a PRIVATE App install on its owner's own repos. */
	public: boolean
}

/**
 * Parse GitHub's manifest-conversion response into a `CreatedGitHubApp`, validating every field at
 * runtime (no casts). Returns null if any required field is missing or the wrong type.
 */
function parseConversion(value: unknown): CreatedGitHubApp | null {
	const id = numberProp(value, 'id')
	const slug = stringProp(value, 'slug')
	const htmlUrl = stringProp(value, 'html_url')
	const pem = stringProp(value, 'pem')
	const webhookSecret = stringProp(value, 'webhook_secret')
	if (id === undefined || slug === undefined || htmlUrl === undefined || pem === undefined || webhookSecret === undefined) {
		return null
	}
	return { id, slug, htmlUrl, pem, webhookSecret }
}

/** How long we wait for the operator to complete the GitHub confirmation before giving up. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Run the full manifest flow:
 *  1. start a local HTTP server on an ephemeral port,
 *  2. serve an auto-submitting form that POSTs the manifest to GitHub,
 *  3. point the operator at the local URL,
 *  4. catch GitHub's redirect (`?code=&state=`), verify the state, exchange the code,
 *  5. return the created App (id/slug/html_url + the secret pem/webhook_secret).
 *
 * Throws on a state mismatch, a non-200 conversion, or a timeout. The server is always stopped.
 */
export async function createAppViaManifest(input: ManifestInput): Promise<CreatedGitHubApp> {
	const state = randomBytes(16).toString('hex')
	const manifest = buildManifest(input)

	// We need the bound port to build the manifest's redirect_url, but the manifest is what the form
	// posts — so bind first (port 0 = ephemeral), then render the form against the real port.
	let resolveApp: (app: CreatedGitHubApp) => void
	let rejectApp: (err: Error) => void
	const appPromise = new Promise<CreatedGitHubApp>((resolve, reject) => {
		resolveApp = resolve
		rejectApp = reject
	})

	const server = Bun.serve({
		port: 0,
		// `fetch` is re-pointed below once we know the port (so redirect_url is correct). Placeholder
		// until then; Bun requires a handler at construction time.
		fetch: () => new Response('starting…', { status: 503 }),
	})
	const port = server.port
	const redirectUrl = `http://localhost:${port}/callback`
	const fullManifest = { ...manifest, redirect_url: redirectUrl }

	server.reload({
		fetch: async (request: Request): Promise<Response> => {
			const requestUrl = new URL(request.url)
			if (requestUrl.pathname === '/') {
				return new Response(renderFormPage(input.org, fullManifest, state), {
					headers: { 'content-type': 'text/html; charset=utf-8' },
				})
			}
			if (requestUrl.pathname === '/callback') {
				try {
					const app = await handleCallback(requestUrl, state)
					resolveApp(app)
					return new Response(renderDonePage(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
				} catch (err) {
					rejectApp(err instanceof Error ? err : new Error(String(err)))
					return new Response(renderErrorPage(), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
				}
			}
			return new Response('not found', { status: 404 })
		},
	})

	const localUrl = `http://localhost:${port}/`
	action('OPERATOR ACTION — create the GitHub App', [
		`1. Open: ${url(localUrl)}`,
		'2. You land on GitHub\'s "Create GitHub App" page — review and click Create.',
		'3. GitHub redirects back here; return to this terminal when you see "done".',
	])
	info('Waiting for you to create the App in the browser…')

	const timeout = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error('Timed out waiting for the GitHub App manifest callback (5 min).')), CALLBACK_TIMEOUT_MS)
	})

	try {
		const app = await Promise.race([appPromise, timeout])
		ok(`GitHub App created: ${app.slug} (id ${app.id})`)
		detail(`App settings: ${app.htmlUrl}`)
		return app
	} finally {
		server.stop(true)
	}
}

/**
 * Exchange the manifest `code` for the created App. `POST /app-manifests/<code>/conversions`. The
 * `state` must match what we generated (CSRF defense — a stray callback can't mint an App for us).
 */
async function handleCallback(requestUrl: URL, expectedState: string): Promise<CreatedGitHubApp> {
	const code = requestUrl.searchParams.get('code')
	const state = requestUrl.searchParams.get('state')
	if (state !== expectedState) {
		throw new Error('Manifest callback state mismatch — ignoring (possible CSRF or a stale tab).')
	}
	if (code === null || code === '') {
		throw new Error('Manifest callback arrived without a code.')
	}
	const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
		method: 'POST',
		headers: {
			Accept: 'application/vnd.github+json',
			'User-Agent': 'vozka-bootstrap-wizard',
		},
	})
	const body: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		throw new Error(`GitHub manifest conversion failed: ${stringProp(body, 'message') ?? `HTTP ${response.status}`}`)
	}
	const app = parseConversion(body)
	if (app === null) {
		throw new Error('GitHub manifest conversion returned an unexpected shape.')
	}
	return app
}

/**
 * The GitHub App manifest. Minimal permissions for vozka's private-repo push deploys: read `contents`
 * (clone) + the `push` event (the webhook trigger). The webhook posts to vozka's own ingest route.
 * `public` is set when the App is owned by one org but installed on another's repos (GitHub only allows a
 * PRIVATE App to be installed on its owner's own repos) — e.g. the manGoweb-account App deploying the
 * poplach/revizor repos that live in the contember org.
 */
function buildManifest(input: ManifestInput): Record<string, unknown> {
	return {
		name: input.appName,
		url: `https://${input.vozkaDomain}`,
		hook_attributes: { url: `https://${input.vozkaDomain}/webhooks/github`, active: true },
		public: input.public,
		default_permissions: { contents: 'read' },
		default_events: ['push'],
	}
}

/**
 * Prompt the operator to INSTALL the freshly created App on the deploy repos, and (best-effort) poll
 * for the install to appear. The install can't be created via the manifest flow — it's a human grant
 * — so this is an action() + a soft confirmation, never a hard block.
 */
export async function promptInstall(app: CreatedGitHubApp, repos: string[]): Promise<void> {
	action('OPERATOR ACTION — install the GitHub App', [
		`1. Open: ${url(`${app.htmlUrl}/installations/new`)}`,
		`2. Install it on: ${repos.join(', ')}`,
		'3. Grant access to those repositories, then return here.',
	])
	const confirmed = await pollInstallation(app.id)
	if (confirmed) {
		ok('GitHub App installation detected.')
	} else {
		// Best-effort only: if `gh` isn't authed or the poll missed, don't block the bring-up. The
		// install just needs to exist before the first push deploy — the operator confirms by eye.
		detail("Could not auto-confirm the installation (that's fine — confirm it in the browser).")
	}
}

/**
 * Best-effort installation check via the `gh` CLI: `gh api /app/installations` lists installations
 * for the App authenticated as itself. We can't authenticate AS the new App here (no JWT signing in
 * the wizard), so this only succeeds if the operator's `gh` happens to have org-admin visibility;
 * otherwise it returns false and the caller treats it as "unconfirmed", not "failed".
 */
async function pollInstallation(appId: number): Promise<boolean> {
	if (!(await hasGhCli())) {
		return false
	}
	for (let attempt = 0; attempt < 12; attempt++) {
		const proc = Bun.spawn(['gh', 'api', `/app/installations/${appId}`], { stdout: 'pipe', stderr: 'pipe' })
		const exitCode = await proc.exited
		if (exitCode === 0) {
			return true
		}
		// 12 attempts × ~5s ≈ a minute of grace while the operator clicks through GitHub's install UI.
		await Bun.sleep(5000)
	}
	return false
}

/** Is the `gh` CLI available on PATH? */
export async function hasGhCli(): Promise<boolean> {
	try {
		const proc = Bun.spawn(['gh', '--version'], { stdout: 'ignore', stderr: 'ignore' })
		return (await proc.exited) === 0
	} catch {
		return false
	}
}

/**
 * The local page served at `/`: a form pre-filled with the manifest JSON that AUTO-SUBMITS to
 * GitHub's "new app from manifest" endpoint. POST (not GET) because the manifest is large; the inline
 * script submits on load so the operator never sees the raw form.
 */
function renderFormPage(org: string, manifest: Record<string, unknown>, state: string): string {
	const githubUrl = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`
	// JSON.stringify twice: once to serialize the manifest, then htmlEscape so it survives as an HTML
	// attribute value. No secrets here — the manifest is non-sensitive app metadata.
	const manifestJson = htmlEscape(JSON.stringify(manifest))
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create vozka GitHub App</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; text-align: center;">
	<h1>Creating the vozka GitHub App…</h1>
	<p>Submitting the manifest to GitHub. If nothing happens, click the button below.</p>
	<form id="manifest-form" method="post" action="${htmlEscape(githubUrl)}">
		<input type="hidden" name="manifest" value="${manifestJson}">
		<button type="submit">Continue to GitHub</button>
	</form>
	<script>document.getElementById('manifest-form').submit()</script>
</body></html>`
}

/** The browser confirmation after a successful conversion — tells the operator to go back to the CLI. */
function renderDonePage(): string {
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Done</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; text-align: center;">
	<h1>&#10003; GitHub App created</h1>
	<p>Return to your terminal — the wizard has captured the App credentials.</p>
</body></html>`
}

/** The browser page on a failed callback. */
function renderErrorPage(): string {
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Error</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; text-align: center;">
	<h1>&#10007; Something went wrong</h1>
	<p>Return to your terminal for details.</p>
</body></html>`
}

/** Minimal HTML escaping for attribute values. */
function htmlEscape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}
