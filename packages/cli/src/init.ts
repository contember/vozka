/**
 * `vozka init <account>` — bring up a CF account's vozka control-plane base from (ideally) just a
 * Cloudflare API token. Idempotent + resumable (every captured value lands in `.env`, which Bun
 * auto-loads on the next run). The REAL deploy runs in GitHub Actions (the scaffolded pipeline calls
 * `vozka platform deploy`), so this laptop never needs the CF toolchain or docker.
 *
 * Order: CF token → account + zones → smart-default prompts → vault key → provisioning key → GitHub App
 * (manifest) → scaffold the base repo → write the GitHub Environment → trigger. Secret VALUES flow only
 * into `.env`, `gh` over stdin, and child env — never through `log.ts`.
 */

import { randomBytes } from 'node:crypto'
import { findZone, listZones, resolveAccountId, verifyToken } from './cloudflare'
import { fromEnv, persistEnv } from './envfile'
import { configureEnvironment, triggerPlatformWorkflow } from './environment'
import { createAppViaManifest, type CreatedGitHubApp, promptInstall } from './github-app'
import { action, detail, info, ok, step, url, warn } from './log'
import { confirm, retry, secretOrEnv, text } from './prompt'
import { defaultCheckoutDir, readVozkaRef, scaffoldPlatformRepo } from './scaffold'

/** Everything collected before the scaffold + environment write. */
interface Collected {
	account: string
	accountId: string
	apiToken: string
	vozkaDomain: string
	githubOrg: string
	platformRepo: string
	propustkaUrl: string
	bootstrapAdmins: string[]
	installRepos: string[]
}

/** Run the full bring-up for `<account>`. */
export async function runInit(account: string): Promise<void> {
	console.log(`\nvozka init — bring up the ${account} control-plane base\n`)

	const collected = await collect(account)
	const vaultKey = await ensureVaultKey()
	const provisioning = await ensureProvisioningKey()
	const app = await ensureGitHubApp(collected)

	const { dir } = await scaffoldPlatformRepo({
		repo: collected.platformRepo,
		account: collected.account,
		dir: defaultCheckoutDir(collected.account),
	})

	await configureEnvironment({
		repo: collected.platformRepo,
		environment: collected.account,
		secrets: {
			CLOUDFLARE_ACCOUNT_ID: collected.accountId,
			CLOUDFLARE_API_TOKEN: collected.apiToken,
			VOZKA_VAULT_KEY: vaultKey,
			GITHUB_APP_PRIVATE_KEY: app.pem,
			GITHUB_WEBHOOK_SECRET: app.webhookSecret,
			PROPUSTKA_PROVISIONING_KEY: provisioning,
		},
		vars: {
			VOZKA_DOMAIN: collected.vozkaDomain,
			GITHUB_APP_ID: String(app.id),
			PROPUSTKA_URL: collected.propustkaUrl,
			VOZKA_BOOTSTRAP_ADMINS: JSON.stringify(collected.bootstrapAdmins),
		},
	})

	await triggerDeploy(collected.platformRepo)
	finalNotes(collected.platformRepo, collected.account, dir, await readVozkaRef(dir))
}

/** Collect the CF token + account, then the smart-default prompts. */
async function collect(account: string): Promise<Collected> {
	step('Cloudflare API token')
	info("Only hard input. It authenticates the deploy AND becomes vozka's runtime CLOUDFLARE_API_TOKEN secret.")
	const verified = await retry('Cloudflare API token', async () => {
		const apiToken = await secretOrEnv('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN')
		detail(`Resolving the Cloudflare account for this token (${apiToken.length} chars)…`)
		const cfAccount = await resolveAccountId(apiToken)
		if (await verifyToken(apiToken, cfAccount.id)) {
			ok('Token verified (status active).')
		} else {
			warn('Could not pre-verify the token via the Cloudflare API.')
			detail('Expected for some account-owned tokens (invisible to /user/tokens/verify); the deploy validates it for real.')
			if (!(await confirm('Proceed anyway?', true))) {
				throw new Error('Token not verified — re-enter it.')
			}
		}
		return { apiToken, cfAccount }
	})
	const { apiToken, cfAccount } = verified
	ok(`Account: ${cfAccount.name} (${cfAccount.id})`)
	await persistEnv('CLOUDFLARE_API_TOKEN', apiToken)
	await persistEnv('CLOUDFLARE_ACCOUNT_ID', cfAccount.id)

	step('Account details (Enter accepts the default)')
	const zones = await listZones(apiToken, cfAccount.id)
	const primaryZone = zones[0]?.name
	const vozkaDomain = await text('vozka domain', primaryZone !== undefined ? `vozka.${primaryZone}` : undefined)
	if (vozkaDomain === '') {
		throw new Error('A vozka domain is required.')
	}
	const zone = await findZone(apiToken, vozkaDomain).catch(() => null)
	if (zone === null) {
		warn(`No Cloudflare zone found for ${vozkaDomain} — a custom-domain bind would fail. Add the zone before the deploy.`)
	} else {
		ok(`Zone found: ${zone.name}`)
	}
	const githubOrg = await text('GitHub org that owns the vozka App + platform repo', account)
	const platformRepo = await text('Platform repo (org/vozka-platform)', `${githubOrg}/vozka-platform`)
	const propustkaUrl = await retry('propustka base URL', async () => {
		const raw = (await text('propustka base URL', primaryZone !== undefined ? `https://propustka.${primaryZone}` : undefined)).replace(/\/+$/, '')
		if (!URL.canParse(raw)) {
			throw new Error(`Not a valid URL: ${raw === '' ? '(empty)' : raw}`)
		}
		return raw
	})
	const adminsRaw = await text('First-admin email(s) for the escape hatch (comma-separated)')
	const bootstrapAdmins = adminsRaw.split(',').map((s) => s.trim()).filter(Boolean)
	const reposRaw = await text('App repos to install the GitHub App on (comma-separated, e.g. contember/poplach)', '')
	const installRepos = reposRaw.split(',').map((s) => s.trim()).filter(Boolean)

	return { account, accountId: cfAccount.id, apiToken, vozkaDomain, githubOrg, platformRepo, propustkaUrl, bootstrapAdmins, installRepos }
}

/**
 * Generate the M4 vault KEK: 32 random bytes, base64. Printed ONCE — it lives nowhere else (never in D1,
 * never logged again), so losing it is unrecoverable. This is the one intentional secret-value print in the
 * whole CLI; it is unavoidable (the operator must capture it) and explicitly loud.
 */
async function ensureVaultKey(): Promise<string> {
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

/**
 * Generate the operator-side provisioning key (the "seeded key"): a single opaque `px_` bearer, stored
 * once. propustka Stage 1 SEEDS it (the `PROPUSTKA_PROVISIONING_KEY` secret — `resolveCaller` admits a
 * bearer matching it as a synthetic admin) and vozka Stage 2 USES it to authenticate schema reconciles.
 * Shaped like a propustka-native key (`px_` + 160 bits base64url). An operator who already has one can
 * pre-set `PROPUSTKA_PROVISIONING_KEY` in env and it is reused verbatim.
 */
async function ensureProvisioningKey(): Promise<string> {
	step('Provisioning key (PROPUSTKA_PROVISIONING_KEY)')
	const existing = fromEnv('PROPUSTKA_PROVISIONING_KEY')
	if (existing !== undefined) {
		ok('Reusing the provisioning key from .env (resume).')
		return existing
	}
	const key = `px_${randomBytes(20).toString('base64url')}`
	await persistEnv('PROPUSTKA_PROVISIONING_KEY', key)
	ok('Provisioning key generated + saved to .env.')
	detail('propustka Stage 1 seeds this as an admin credential; vozka Stage 2 reconciles with it.')
	return key
}

/** Create the GitHub App via the manifest flow (or reuse from .env), then prompt to install it. */
async function ensureGitHubApp(collected: Collected): Promise<CreatedGitHubApp> {
	step('Create the vozka GitHub App (manifest flow)')
	const pem = fromEnv('GITHUB_APP_PRIVATE_KEY')
	const webhookSecret = fromEnv('GITHUB_WEBHOOK_SECRET')
	if (pem !== undefined && webhookSecret !== undefined) {
		const slug = fromEnv('GITHUB_APP_SLUG') ?? 'vozka'
		ok('Reusing the GitHub App from .env (resume) — skipping manifest creation.')
		const app: CreatedGitHubApp = {
			id: Number(fromEnv('GITHUB_APP_ID') ?? '0'),
			slug,
			htmlUrl: fromEnv('GITHUB_APP_URL') ?? `https://github.com/apps/${slug}`,
			pem,
			webhookSecret,
		}
		detail(`Install (if needed): ${url(`https://github.com/apps/${app.slug}/installations/new`)}`)
		return app
	}
	const appName = await text('GitHub App name', `vozka-${collected.account}`)
	// PUBLIC iff installed across orgs: GitHub only lets a private App install on its OWNER's repos, so an
	// App owned by this account's org but deploying repos in another org (e.g. manGoweb-owned, deploying
	// contember/poplach) must be public. Same-org installs stay private.
	const ownerOrg = collected.githubOrg.toLowerCase()
	const isPublic = collected.installRepos.some((repo) => (repo.split('/')[0] ?? '').toLowerCase() !== ownerOrg)
	const app = await createAppViaManifest({ org: collected.githubOrg, appName, vozkaDomain: collected.vozkaDomain, public: isPublic })
	await persistEnv('GITHUB_APP_PRIVATE_KEY', app.pem)
	await persistEnv('GITHUB_WEBHOOK_SECRET', app.webhookSecret)
	await persistEnv('GITHUB_APP_ID', String(app.id))
	await persistEnv('GITHUB_APP_SLUG', app.slug)
	await persistEnv('GITHUB_APP_URL', app.htmlUrl)
	ok('GitHub App credentials saved to .env (resume-safe).')
	if (collected.installRepos.length > 0) {
		await promptInstall(app, collected.installRepos)
	} else {
		detail(`Install the App on the repos vozka will deploy when you onboard them: ${url(`https://github.com/apps/${app.slug}/installations/new`)}`)
	}
	return app
}

/** Trigger the platform workflow (first bring-up builds the runner image into this account's registry). */
async function triggerDeploy(repo: string): Promise<void> {
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
	await triggerPlatformWorkflow(repo, true)
	ok('Platform workflow triggered.')
	detail(`Watch: ${url(`https://github.com/${repo}/actions`)}   (or: gh run watch --repo ${repo})`)
}

/** Closing notes: the local checkout, the escape hatch, and what runs in CI. */
function finalNotes(repo: string, account: string, dir: string, ref: string): void {
	step('Done')
	ok(`Base repo: ${repo} (pinned vozka ref: ${ref})`)
	ok(`Local checkout + .env: ${dir}`)
	info('vozka came up with the bootstrap-admin escape hatch OPEN (VOZKA_BOOTSTRAP_ADMINS set).')
	action('OPERATOR ACTION — close the hatch after propustka grants you the vozka admin role', [
		`1. gh variable set VOZKA_BOOTSTRAP_ADMINS --repo ${repo} --env ${account} --body '[]'`,
		`2. gh workflow run platform.yml --repo ${repo}`,
		'3. Authorization is then fully propustka-owned.',
	])
}
