/**
 * The SHARED vozka bring-up — the second half of BOTH flows (migrate + fresh) once propustka coords are
 * in hand. In the per-account base-repo model it does NOT deploy from the laptop; instead it:
 *   1. generates the vault KEK (printed ONCE, loud),
 *   2. creates the vozka GitHub App via the manifest flow + prompts to install it on the app repos,
 *   3. assembles the full secret/var set vozka needs,
 *   4. writes them into the account's `<org>/vozka-platform` repo (`gh secret set` / `gh variable set`),
 *   5. triggers that repo's `platform` workflow — GitHub Actions runs the REAL deploy (vozka-runner + vozka),
 *   6. reminds the operator to close the escape hatch once propustka grants them admin.
 *
 * The actual deploy runs in CI (the base-repo pipeline calls `vozka platform deploy`), NOT here — so the
 * laptop never needs the CF deploy toolchain or docker. Secret VALUES flow only into `gh` over stdin; this
 * module never logs a value (the vault key is the one value printed, ONCE, by design — the operator must
 * store it).
 */

import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fromEnv, persistEnv } from './envfile'
import { createAppViaManifest, type CreatedGitHubApp, hasGhCli, promptInstall } from './github-app'
import { action, detail, info, ok, step, url, warn } from './log'
import { confirm, select, text } from './prompt'
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
	/** GitHub org the App is created under — the app repos' org (e.g. contember). */
	githubOrg: string
	/** Deploy target env name (default prod). */
	env: string
	/** The account's base repo to configure + trigger, e.g. `manGoweb/vozka-platform`. */
	platformRepo: string
	/** App repos to install the GitHub App on (the apps vozka deploys via webhook). May be empty. */
	installRepos: string[]
}

/** The repo root — a harmless cwd anchor for the `gh` shell-outs (gh ignores cwd when `--repo` is given). */
const repoRoot = resolve(import.meta.dir, '..', '..')

/** Repo Secrets (sensitive) the platform workflow consumes — written via `gh secret set` over STDIN. The
 *  names mirror `<org>/vozka-platform`'s `.github/workflows/platform.yml`. */
const REPO_SECRETS = [
	'CLOUDFLARE_ACCOUNT_ID',
	'CLOUDFLARE_API_TOKEN',
	'VOZKA_VAULT_KEY',
	'GITHUB_APP_PRIVATE_KEY',
	'GITHUB_WEBHOOK_SECRET',
	'PROPUSTKA_CLIENT_ID',
	'PROPUSTKA_CLIENT_SECRET',
]

/** Repo Variables (non-secret) the platform workflow consumes — written via `gh variable set`. */
const REPO_VARS = ['VOZKA_DOMAIN', 'GITHUB_APP_ID', 'PROPUSTKA_URL', 'VOZKA_BOOTSTRAP_ADMINS']

/** Run the shared vozka bring-up: vault key + GitHub App, then configure the base repo + trigger CI. */
export async function runVozkaBringup(collected: BringupInput): Promise<void> {
	const vaultKey = await generateVaultKey()
	const { app, reused } = await createGitHubApp(collected)
	if (reused) {
		detail(`GitHub App: reused from .env. Install (if needed): ${url(`${app.htmlUrl}/installations/new`)}`)
	} else if (collected.installRepos.length > 0) {
		await promptInstall(app, collected.installRepos)
	} else {
		detail(`Install the App on the repos vozka will deploy when you onboard them: ${url(`${app.htmlUrl}/installations/new`)}`)
	}

	const env = assembleEnv(collected, vaultKey, app)
	await configureRepoAndTrigger(collected.platformRepo, env)
	closeHatchReminder(collected.platformRepo)
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
 * Assemble the full secret/var set the platform workflow reads (the SAME names vozka.config declares). The
 * secret VALUES live in this object and flow into `gh` over stdin — never logged, never written to disk.
 * `GITHUB_APP_ID` is included because vozka.config reads it from the env (App-JWT `iss`); omitting it ships
 * a vozka that 401s on GitHub installation-token mint.
 */
function assembleEnv(collected: BringupInput, vaultKey: string, app: CreatedGitHubApp): Record<string, string> {
	return {
		CLOUDFLARE_ACCOUNT_ID: collected.accountId,
		CLOUDFLARE_API_TOKEN: collected.apiToken,
		VOZKA_DOMAIN: collected.vozkaDomain,
		PROPUSTKA_URL: collected.propustkaUrl,
		PROPUSTKA_CLIENT_ID: collected.propustkaClientId,
		PROPUSTKA_CLIENT_SECRET: collected.propustkaClientSecret,
		VOZKA_VAULT_KEY: vaultKey,
		GITHUB_APP_ID: String(app.id),
		GITHUB_APP_PRIVATE_KEY: app.pem,
		GITHUB_WEBHOOK_SECRET: app.webhookSecret,
		VOZKA_BOOTSTRAP_ADMINS: JSON.stringify(collected.bootstrapAdmins),
	}
}

/**
 * Write the assembled secrets + variables into the account's `<org>/vozka-platform` repo and trigger its
 * `platform` workflow. Secret values go to `gh secret set` over STDIN (never argv, never logged); the
 * non-secret variables go to `gh variable set --body`. Then `gh workflow run platform.yml
 * -f build_runner_image=true` kicks off the REAL deploy in GitHub Actions (vozka-runner + vozka).
 */
async function configureRepoAndTrigger(repo: string, env: Record<string, string>): Promise<void> {
	step(`Configure the platform repo (${repo}) — Secrets + Variables`)
	await ensureGhRepo(repo)

	for (const name of REPO_SECRETS) {
		const value = env[name]
		if (value === undefined || value === '') {
			warn(`Skipping ${name} — no value (the workflow will fail without it; set it manually).`)
			continue
		}
		await run({ command: 'gh', args: ['secret', 'set', name, '--repo', repo], cwd: repoRoot, stdin: value })
		ok(`secret ${name} set`)
	}
	for (const name of REPO_VARS) {
		await run({ command: 'gh', args: ['variable', 'set', name, '--repo', repo, '--body', env[name] ?? ''], cwd: repoRoot })
		ok(`variable ${name} set`)
	}

	step('Trigger the platform deploy (GitHub Actions)')
	info('GitHub Actions runs the real deploy — vozka-runner then vozka. The first run builds the runner')
	info('container image into this account (CI has docker); this laptop deploys nothing.')
	const go = await confirm(`Run the platform workflow on ${repo} now (build_runner_image=true)?`, true)
	if (!go) {
		action('OPERATOR ACTION — run it when ready', [
			`gh workflow run platform.yml --repo ${repo} -f build_runner_image=true`,
			`or: ${url(`https://github.com/${repo}/actions`)} → platform → Run workflow`,
		])
		return
	}
	await run({ command: 'gh', args: ['workflow', 'run', 'platform.yml', '--repo', repo, '-f', 'build_runner_image=true'], cwd: repoRoot })
	ok('Platform workflow triggered.')
	detail(`Watch: ${url(`https://github.com/${repo}/actions`)}   (or: gh run watch --repo ${repo})`)
}

/** Verify `gh` is available + authed + can see the target repo; throw a clear error otherwise. */
async function ensureGhRepo(repo: string): Promise<void> {
	if (!(await hasGhCli())) {
		throw new Error('`gh` (GitHub CLI) is required to set repo secrets — install it and run `gh auth login`.')
	}
	const proc = Bun.spawn(['gh', 'repo', 'view', repo, '--json', 'nameWithOwner'], { stdout: 'ignore', stderr: 'ignore' })
	if ((await proc.exited) !== 0) {
		throw new Error(`Cannot access ${repo} via gh — create the per-account vozka-platform repo first, and ensure your gh login can admin it.`)
	}
}

/**
 * Close-the-hatch reminder. The bring-up set VOZKA_BOOTSTRAP_ADMINS (the escape hatch OPEN). Once
 * propustka grants the operator a real admin role, they clear that repo Variable and re-run the workflow
 * to close the hatch (authorization fully propustka-owned again).
 */
function closeHatchReminder(repo: string): void {
	step('Final: close the escape hatch')
	info('vozka came up with the bootstrap-admin escape hatch OPEN (VOZKA_BOOTSTRAP_ADMINS set).')
	action('OPERATOR ACTION — close the hatch after propustka grants you the vozka admin role', [
		`1. gh variable set VOZKA_BOOTSTRAP_ADMINS --repo ${repo} --body '[]'`,
		`2. gh workflow run platform.yml --repo ${repo}`,
		'3. Authorization is then fully propustka-owned.',
	])
}

/**
 * Shared collector for the vozka-portion inputs both flows ask for AFTER propustka coords are known:
 * VOZKA_DOMAIN, the App/app-repos org, the per-account platform repo, first-admin email(s), and the app
 * repos to install the App on. Kept here so migrate + fresh stay in lockstep. (CF creds + propustka coords
 * are passed in by each flow.)
 */
export async function collectBringupCommon(defaults: { githubOrg: string }): Promise<{
	vozkaDomain: string
	githubOrg: string
	platformRepo: string
	bootstrapAdmins: string[]
	env: string
	installRepos: string[]
}> {
	const vozkaDomain = await text('vozka domain (e.g. vozka.example.com)')
	const githubOrg = await text('GitHub org for the App + app repos', defaults.githubOrg)
	const platformRepo = await text('Platform repo to configure (org/vozka-platform)', `${githubOrg}/vozka-platform`)
	const adminsRaw = await text('First-admin email(s) for the escape hatch (comma-separated)')
	const bootstrapAdmins = adminsRaw.split(',').map((s) => s.trim()).filter(Boolean)
	const envChoice = await select('Deploy environment', [
		{ label: 'prod', value: 'prod' },
		{ label: 'stage', value: 'stage' },
	])
	const reposRaw = await text('App repos to install the GitHub App on (comma-separated, optional)', '')
	const installRepos = reposRaw.split(',').map((s) => s.trim()).filter(Boolean)
	return { vozkaDomain, githubOrg, platformRepo, bootstrapAdmins, env: envChoice, installRepos }
}
