/**
 * The SHARED vozka bring-up — the second half of BOTH flows (migrate + fresh) once propustka coords
 * are in hand. It:
 *   1. generates the vault KEK (printed ONCE, loud),
 *   2. creates the GitHub App via the manifest flow and prompts for its install,
 *   3. assembles the full env Record the bootstrap script expects,
 *   4. shells out to `scripts/bootstrap.ts --dry-run`, shows the plan, asks to confirm, then the real run,
 *   5. health-checks the live control plane,
 *   6. optionally seeds the app registry (scripts/seed.ts) — else points the operator at the dashboard,
 *   7. reminds the operator to close the escape hatch once propustka grants them admin.
 *
 * It ORCHESTRATES the existing bootstrap.ts / seed.ts (shells out) — it never duplicates their deploy
 * logic. Secret values flow only into the child env; this module never logs a value (the vault key is
 * the one value printed, ONCE, by design — it has no other home and the operator must store it).
 */

import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fromEnv, persistEnv } from './envfile'
import { createAppViaManifest, type CreatedGitHubApp, promptInstall } from './github-app'
import { action, detail, info, ok, step, url, warn } from './log'
import { confirm, secret, select, text } from './prompt'
import { run } from './shell'

/** Everything collected by a flow before the shared bring-up runs. */
export interface BringupInput {
	/** The single CF account vozka deploys into. */
	accountId: string
	/** The CF token — the deploy cred AND vozka's runtime CLOUDFLARE_API_TOKEN secret. */
	apiToken: string
	/** vozka's hostname (drives Access destinations, vars, health URL). */
	vozkaDomain: string
	/** The one propustka's base URL. */
	propustkaUrl: string
	/** vozka's propustka provisioning key (clientId/secret). */
	propustkaClientId: string
	propustkaClientSecret: string
	/** First-operator admin email(s) for VOZKA_BOOTSTRAP_ADMINS (escape hatch). */
	bootstrapAdmins: string[]
	/** GitHub org the App is created under (default contember). */
	githubOrg: string
	/** Deploy target env name (default prod). */
	env: string
	/** Repos to install the GitHub App on (vozka + propustka, by default). */
	installRepos: string[]
	/** Repo URLs + the propustka app domain, for the optional seed step. */
	vozkaRepoUrl: string
	propustkaRepoUrl: string
	propustkaAppDomain: string
}

/** The packages/worker directory (where bootstrap.ts/seed.ts live) — the cwd for those shell-outs.
 *  Resolved from this file at <repo>/scripts/wizard/ up to the repo root, then into packages/worker. */
const workerDir = resolve(import.meta.dir, '..', '..', 'packages', 'worker')

/** Run the shared vozka bring-up. Throws on any hard failure (bad deploy, etc.). */
export async function runVozkaBringup(collected: BringupInput): Promise<void> {
	const vaultKey = await generateVaultKey()
	const { app, reused } = await createGitHubApp(collected)
	if (reused) {
		// A reused App was already created AND installed by the run that first persisted it — installs
		// persist on GitHub across runs — so there is nothing to do here (skip the prompt + the poll).
		detail(`GitHub App install: already done (reused). If ever needed: ${url(`${app.htmlUrl}/installations/new`)}`)
	} else {
		await promptInstall(app, collected.installRepos)
	}

	const env = assembleEnv(collected, vaultKey, app.pem, app.webhookSecret)

	await bootstrapDryThenReal(env)
	await healthCheck(collected.vozkaDomain)
	await seedOrPointToDashboard(collected)
	closeHatchReminder(collected.vozkaDomain)
}

/**
 * Generate the M4 vault KEK: 32 random bytes, base64. Printed ONCE — it lives nowhere else (never in
 * D1, never logged again), so losing it is unrecoverable. This is the one intentional secret-value
 * print in the whole wizard; it is unavoidable (the operator must capture it) and explicitly loud.
 */
async function generateVaultKey(): Promise<string> {
	step('Generate the vault master key (VOZKA_VAULT_KEY)')
	const existing = fromEnv('VOZKA_VAULT_KEY')
	if (existing !== undefined) {
		ok('Reusing VOZKA_VAULT_KEY from .env (resume).')
		return existing
	}
	const key = randomBytes(32).toString('base64')
	await persistEnv('VOZKA_VAULT_KEY', key)
	action('SAVED to .env (gitignored) — ALSO copy it to your password manager: vault KEK, UNRECOVERABLE if lost', [
		"It is the master key for vozka's encrypted secret vault.",
		'',
		`  VOZKA_VAULT_KEY=${key}`,
	])
	return key
}

/** Create the GitHub App via the manifest flow (org + app name + domain → id/pem/webhook_secret). */
async function createGitHubApp(collected: BringupInput): Promise<{ app: CreatedGitHubApp; reused: boolean }> {
	step('Create the vozka GitHub App (manifest flow)')
	const pem = fromEnv('GITHUB_APP_PRIVATE_KEY')
	const webhookSecret = fromEnv('GITHUB_WEBHOOK_SECRET')
	if (pem !== undefined && webhookSecret !== undefined) {
		const slug = fromEnv('GITHUB_APP_SLUG') ?? 'vozka'
		ok('Reusing the GitHub App from .env (resume) — skipping manifest creation.')
		return {
			app: {
				id: Number(fromEnv('GITHUB_APP_ID') ?? '0'),
				slug,
				htmlUrl: fromEnv('GITHUB_APP_URL') ?? `https://github.com/organizations/${collected.githubOrg}/settings/apps/${slug}`,
				pem,
				webhookSecret,
			},
			reused: true,
		}
	}
	const appName = await text('GitHub App name', `vozka-${collected.env}`)
	const app = await createAppViaManifest({ org: collected.githubOrg, appName, vozkaDomain: collected.vozkaDomain })
	await persistEnv('GITHUB_APP_PRIVATE_KEY', app.pem)
	await persistEnv('GITHUB_WEBHOOK_SECRET', app.webhookSecret)
	await persistEnv('GITHUB_APP_ID', String(app.id))
	await persistEnv('GITHUB_APP_SLUG', app.slug)
	await persistEnv('GITHUB_APP_URL', app.htmlUrl)
	ok('GitHub App credentials saved to .env (resume-safe).')
	return { app, reused: false }
}

/**
 * Assemble the full env Record the bootstrap script reads (the SAME names vozka.config declares). The
 * secret VALUES (token, vault key, propustka secret, PEM, webhook secret) live in this object and flow
 * straight into the child's env — never logged, never written to disk.
 */
function assembleEnv(collected: BringupInput, vaultKey: string, pem: string, webhookSecret: string): Record<string, string> {
	return {
		CLOUDFLARE_ACCOUNT_ID: collected.accountId,
		CLOUDFLARE_API_TOKEN: collected.apiToken,
		VOZKA_DOMAIN: collected.vozkaDomain,
		PROPUSTKA_URL: collected.propustkaUrl,
		PROPUSTKA_CLIENT_ID: collected.propustkaClientId,
		PROPUSTKA_CLIENT_SECRET: collected.propustkaClientSecret,
		VOZKA_VAULT_KEY: vaultKey,
		GITHUB_APP_PRIVATE_KEY: pem,
		GITHUB_WEBHOOK_SECRET: webhookSecret,
		VOZKA_BOOTSTRAP_ADMINS: JSON.stringify(collected.bootstrapAdmins),
		VOZKA_ENV: collected.env,
	}
}

/**
 * Run the vozka self-deploy: ALWAYS `scripts/bootstrap.ts --dry-run` first (plan-only), show its
 * output, get an explicit confirm, THEN the real run. The dry-run is non-mutating; the real run is
 * gated behind the operator. Both inherit stdio so the engine's per-step output streams live.
 */
async function bootstrapDryThenReal(env: Record<string, string>): Promise<void> {
	step('Plan the vozka deploy (bootstrap --dry-run)')
	info('Running the engine in plan-only mode — no Cloudflare, no propustka changes.')
	await run({ command: 'bun', args: ['run', 'scripts/bootstrap.ts', '--dry-run'], cwd: workerDir, env })

	step('Deploy vozka for real')
	const go = await confirm('The dry-run above is the plan. Deploy vozka FOR REAL now?', false)
	if (!go) {
		throw new Error('Aborted before the real deploy (re-run the wizard to retry).')
	}
	await run({ command: 'bun', args: ['run', 'scripts/bootstrap.ts'], cwd: workerDir, env })
	ok('vozka deployed.')
}

/**
 * Poll `GET https://<domain>/api/health` until it returns ok or ~90s elapse. Access fronts the host,
 * but `/api/health` is the unauthenticated liveness route (see the worker fetch router), so a plain
 * GET should pass once the Worker + custom domain are live. A timeout WARNS (the deploy may still be
 * settling) rather than failing the whole bring-up.
 */
async function healthCheck(domain: string): Promise<void> {
	step('Health-check the live control plane')
	const target = `https://${domain}/api/health`
	info(`Polling ${url(target)} (up to ~90s)…`)
	const deadline = Date.now() + 90_000
	for (;;) {
		const healthy = await probe(target)
		if (healthy) {
			ok('Control plane is healthy.')
			return
		}
		if (Date.now() >= deadline) {
			warn('Health check did not pass within ~90s — the deploy may still be propagating. Check manually.')
			return
		}
		await Bun.sleep(5000)
	}
}

/** One health probe: a 200 is healthy; anything else / network error is not (we keep polling). */
async function probe(target: string): Promise<boolean> {
	try {
		const response = await fetch(target, { method: 'GET' })
		return response.ok
	} catch {
		return false
	}
}

/**
 * Seed the app registry (scripts/seed.ts) — but only if the operator supplies an Access service token
 * for the machine-to-machine API call. The seed POSTs to vozka's gated `/api/*`, so without a service
 * token it would hit the Access front door with no identity. If the operator declines, we skip and
 * point them at the dashboard to onboard the apps with a human Access login instead.
 */
async function seedOrPointToDashboard(collected: BringupInput): Promise<void> {
	step('Register apps in the control-plane registry (seed)')
	const withToken = await confirm('Seed the app registry now with an Access SERVICE token?', true)
	if (!withToken) {
		action('OPERATOR ACTION — onboard apps via the dashboard', [
			`1. Open the dashboard: ${url(`https://${collected.vozkaDomain}`)}`,
			'2. Sign in with Cloudflare Access (human login).',
			'3. Register the vozka + propustka apps via the UI.',
		])
		return
	}
	info('Paste an Access service token (CF-Access-Client-Id / -Secret) authorized for the operator host.')
	const clientId = await secret('CF_ACCESS_CLIENT_ID')
	const clientSecret = await secret('CF_ACCESS_CLIENT_SECRET')
	await run({
		command: 'bun',
		args: ['run', 'scripts/seed.ts'],
		cwd: workerDir,
		env: {
			VOZKA_API_URL: `https://${collected.vozkaDomain}`,
			VOZKA_REPO_URL: collected.vozkaRepoUrl,
			PROPUSTKA_REPO_URL: collected.propustkaRepoUrl,
			VOZKA_APP_DOMAIN: collected.vozkaDomain,
			PROPUSTKA_APP_DOMAIN: collected.propustkaAppDomain,
			SEED_ENV: collected.env,
			CF_ACCESS_CLIENT_ID: clientId,
			CF_ACCESS_CLIENT_SECRET: clientSecret,
		},
	})
	ok('App registry seeded — pushes to the registered repos now self-deploy through vozka.')
}

/**
 * Close-the-hatch reminder. The bring-up ran with VOZKA_BOOTSTRAP_ADMINS set (the escape hatch OPEN).
 * Once propustka grants the operator a real admin role, they must re-run bootstrap WITHOUT that var to
 * close the hatch (authorization fully propustka-owned again). We only point them at the script.
 */
function closeHatchReminder(domain: string): void {
	step('Final: close the escape hatch')
	info('vozka came up with the bootstrap-admin escape hatch OPEN (VOZKA_BOOTSTRAP_ADMINS set).')
	action('OPERATOR ACTION — close the hatch after propustka grants you admin', [
		`1. In the propustka admin UI, grant yourself the vozka ADMIN role.`,
		'2. Re-run WITHOUT the bootstrap admins to close the hatch:',
		'     bun run scripts/bootstrap.ts        (no VOZKA_BOOTSTRAP_ADMINS)',
		'3. Authorization is then fully propustka-owned.',
	])
	detail(`Dashboard: ${url(`https://${domain}`)}`)
}

/**
 * Shared collector for the vozka-portion inputs both flows ask for AFTER propustka coords are known:
 * VOZKA_DOMAIN, GitHub org, first-admin email(s), repo URLs. Kept here so migrate + fresh stay in
 * lockstep on what the bring-up needs. (CF creds + propustka coords are passed in by each flow.)
 */
export async function collectBringupCommon(defaults: { githubOrg: string }): Promise<{
	vozkaDomain: string
	githubOrg: string
	bootstrapAdmins: string[]
	env: string
	vozkaRepoUrl: string
	propustkaRepoUrl: string
	installRepos: string[]
}> {
	const vozkaDomain = await text('vozka domain (e.g. vozka.example.com)')
	const githubOrg = await text('GitHub org', defaults.githubOrg)
	const adminsRaw = await text('First-admin email(s) for the escape hatch (comma-separated)')
	const bootstrapAdmins = adminsRaw.split(',').map((s) => s.trim()).filter(Boolean)
	const envChoice = await select('Deploy environment', [
		{ label: 'prod', value: 'prod' },
		{ label: 'stage', value: 'stage' },
	])
	const vozkaRepoUrl = await text('vozka repo URL', `https://github.com/${githubOrg}/vozka`)
	const propustkaRepoUrl = await text('propustka repo URL', `https://github.com/${githubOrg}/propustka`)
	const installRepos = [`${githubOrg}/vozka`, `${githubOrg}/propustka`]
	return { vozkaDomain, githubOrg, bootstrapAdmins, env: envChoice, vozkaRepoUrl, propustkaRepoUrl, installRepos }
}
