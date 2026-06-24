/**
 * propustka orchestration for the wizard. propustka is the authz/Access front door vozka authenticates
 * through, so on a fresh account it must come up FIRST. This module:
 *   - `mintProvisioningKey()` — shells out to propustka's own `scripts/provision-key.ts` and PARSES the
 *     two `PROPUSTKA_ACCESS_CLIENT_ID=…` / `PROPUSTKA_ACCESS_CLIENT_SECRET=…` lines it prints,
 *   - `deployPropustkaFresh()` — replicates propustka's `.github/workflows/deploy.yml` step sequence as
 *     shell-outs, for the nothing-exists flow,
 *   - `firstAdminKeyHint()` — the chicken-and-egg hand-off: the FIRST propustka admin key is minted by a
 *     human in propustka's admin UI, not by a script.
 *
 * It NEVER re-implements propustka's deploy logic — it shells out to propustka's own scripts/tools, the
 * same way CI does. Secret values (the operator's admin token, the minted key) flow only into child env
 * and back as return values; never logged.
 */

import { action, detail, info, ok, step, url, warn } from './log'
import { capture, run } from './shell'

/** The minted vozka provisioning key — propustka's `clientId`/`clientSecret` for vozka's CI reconcile. */
export interface ProvisioningKey {
	clientId: string
	clientSecret: string
}

interface MintInput {
	propustkaPath: string
	propustkaUrl: string
	/** The ADMIN Access service token that authorizes minting (operator-held; never logged). */
	adminClientId: string
	adminClientSecret: string
}

/**
 * Mint a vozka provisioning key by shelling out to propustka's `scripts/provision-key.ts --app vozka`
 * and parsing the two key=value lines it prints to stdout. The admin Access service token authorizes
 * the call (passed as env to the child only). Returns the minted clientId/clientSecret; throws if
 * either line is missing from the output.
 */
export async function mintProvisioningKey(input: MintInput): Promise<ProvisioningKey> {
	info('Minting a vozka provisioning key via propustka scripts/provision-key.ts…')
	const stdout = await capture({
		command: 'bun',
		args: ['run', 'scripts/provision-key.ts', '--app', 'vozka'],
		cwd: input.propustkaPath,
		env: {
			PROPUSTKA_URL: input.propustkaUrl,
			PROPUSTKA_ACCESS_CLIENT_ID: input.adminClientId,
			PROPUSTKA_ACCESS_CLIENT_SECRET: input.adminClientSecret,
		},
	})
	const key = parseProvisioningKey(stdout)
	if (key === null) {
		// We DELIBERATELY do not echo stdout here — on the happy path it carries the secret; on a
		// failure path it may carry a partial value. Just report the shape mismatch.
		throw new Error('Could not parse PROPUSTKA_ACCESS_CLIENT_ID / _SECRET from provision-key.ts output.')
	}
	ok('Provisioning key minted (clientId/secret captured into the deploy env — not shown).')
	return key
}

/**
 * Parse the `PROPUSTKA_ACCESS_CLIENT_ID=<id>` / `PROPUSTKA_ACCESS_CLIENT_SECRET=<secret>` lines that
 * provision-key.ts prints. Returns null if either is absent. Exported for clarity of the contract;
 * kept tolerant of surrounding log lines (the script prints a banner around the two values).
 */
export function parseProvisioningKey(stdout: string): ProvisioningKey | null {
	const id = matchLine(stdout, 'PROPUSTKA_ACCESS_CLIENT_ID')
	const secret = matchLine(stdout, 'PROPUSTKA_ACCESS_CLIENT_SECRET')
	if (id === null || secret === null) {
		return null
	}
	return { clientId: id, clientSecret: secret }
}

/** Extract the value of a `NAME=value` line from multiline text (trims surrounding whitespace). */
function matchLine(text: string, name: string): string | null {
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		const prefix = `${name}=`
		if (trimmed.startsWith(prefix)) {
			const value = trimmed.slice(prefix.length).trim()
			return value === '' ? null : value
		}
	}
	return null
}

/** Everything propustka's fresh deploy needs (mirrors deploy.yml's env + provision-access.ts's env). */
export interface PropustkaFreshInput {
	propustkaPath: string
	/** CF deploy creds — also become propustka's runtime CF_API_TOKEN / CF_ACCOUNT_ID secrets. */
	accountId: string
	apiToken: string
	/** The propustka admin hostname (Custom Domain) — drives the Worker route + Access destinations. */
	hostname: string
	/** CF Access team URL (PROPUSTKA_TEAM), e.g. https://acme.cloudflareaccess.com */
	team: string
	/** PROPUSTKA_ACCESS_APPS JSON (aud → appId). Empty `{}` on the very first deploy, refined after. */
	accessApps: string
	/** Central human Access audience — domains (required) + emails (optional), JSON arrays or CSV. */
	humanEmailDomains: string
	humanEmails: string
	/** The first propustka admin email (PROPUSTKA_BOOTSTRAP_ADMINS) — opens propustka's own hatch once. */
	bootstrapAdmins: string
	/** Target CF env name (propustka's KNOWN_ENVS: stage/prod/mangoweb). Default prod. */
	env: string
}

/**
 * Deploy propustka from nothing, replicating `.github/workflows/deploy.yml`'s step sequence as
 * shell-outs against a local propustka checkout. Each step runs with ONLY the env it needs:
 *
 *   1. build the admin-ui SPA (served by the Worker via ASSETS),
 *   2. `oblaka oblaka.ts --env=<env> --state-namespace=propustka-state --remote` (provision + wrangler.jsonc),
 *   3. `wrangler d1 migrations apply DB --remote`,
 *   4. `wrangler deploy`,
 *   5. `wrangler secret put CF_API_TOKEN` / `CF_ACCOUNT_ID` (the runtime Access-API creds, via stdin),
 *   6. `scripts/provision-access.ts` (bootstrap propustka-admin's OWN Access front door).
 *
 * The wrangler/oblaka steps read CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from env; oblaka also
 * needs CF_API_TOKEN / CF_ACCOUNT_ID (it validates them) plus the PROPUSTKA_* vars; provision-access
 * needs CF_API_TOKEN / CF_ACCOUNT_ID + the hostname + the human audience. We never log a value.
 */
export async function deployPropustkaFresh(input: PropustkaFreshInput): Promise<void> {
	const worker = `${input.propustkaPath}/packages/worker`
	const adminUi = `${input.propustkaPath}/packages/admin-ui`

	// Shared CF creds for the wrangler/oblaka CLIs (they read CLOUDFLARE_*), plus oblaka's own CF_*.
	const cfEnv: Record<string, string> = {
		CLOUDFLARE_API_TOKEN: input.apiToken,
		CLOUDFLARE_ACCOUNT_ID: input.accountId,
		CF_API_TOKEN: input.apiToken,
		CF_ACCOUNT_ID: input.accountId,
	}

	step('Build propustka admin-ui SPA')
	await run({ command: 'bun', args: ['run', 'build'], cwd: adminUi })

	step('Provision propustka (oblaka --remote)')
	await run({
		command: 'bunx',
		args: ['oblaka', 'oblaka.ts', `--env=${input.env}`, '--state-namespace=propustka-state', '--remote'],
		cwd: worker,
		env: {
			...cfEnv,
			PROPUSTKA_ACCESS_APPS: input.accessApps,
			PROPUSTKA_TEAM: input.team,
			PROPUSTKA_HUMAN_EMAIL_DOMAINS: input.humanEmailDomains,
			PROPUSTKA_HUMAN_EMAILS: input.humanEmails,
			PROPUSTKA_HOSTNAME: input.hostname,
			PROPUSTKA_BOOTSTRAP_ADMINS: input.bootstrapAdmins,
		},
	})

	step('Apply propustka D1 migrations (remote)')
	await run({ command: 'bunx', args: ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote'], cwd: worker, env: cfEnv })

	step('Deploy propustka Worker')
	await run({ command: 'bunx', args: ['wrangler', 'deploy'], cwd: worker, env: cfEnv })

	step('Set propustka Worker secrets (Access API)')
	// wrangler reads the secret value from stdin — the value never appears on argv or in a log line.
	await run({ command: 'bunx', args: ['wrangler', 'secret', 'put', 'CF_API_TOKEN'], cwd: worker, env: cfEnv, stdin: input.apiToken })
	await run({ command: 'bunx', args: ['wrangler', 'secret', 'put', 'CF_ACCOUNT_ID'], cwd: worker, env: cfEnv, stdin: input.accountId })
	ok('CF_API_TOKEN + CF_ACCOUNT_ID set as Worker secrets.')

	step("Bootstrap propustka-admin's Access front door (provision-access.ts)")
	await run({
		command: 'bun',
		args: ['run', 'scripts/provision-access.ts'],
		cwd: input.propustkaPath,
		env: {
			CF_API_TOKEN: input.apiToken,
			CF_ACCOUNT_ID: input.accountId,
			PROPUSTKA_HOSTNAME: input.hostname,
			PROPUSTKA_HUMAN_EMAIL_DOMAINS: input.humanEmailDomains,
			PROPUSTKA_HUMAN_EMAILS: input.humanEmails,
		},
	})
	ok(`propustka is live at ${url(`https://${input.hostname}`)}`)
	warn('provision-access.ts printed a PROPUSTKA_ACCESS_APPS value — save it as the propustka GitHub Environment var for future CI deploys.')
}

/**
 * The chicken-and-egg hand-off for the FIRST propustka admin key. There is no admin Access service
 * token yet (none has been minted), so the first one MUST be created by a human signing into the
 * propustka admin UI with their browser. This prints the instructions and tells the operator they'll
 * be prompted to paste the resulting client id/secret next (so the wizard can mint vozka's key with it).
 */
export function firstAdminKeyHint(hostname: string): void {
	step('Mint the FIRST propustka admin key (human, in the browser)')
	info('propustka has no admin Access service token yet — the first one is minted by a human, not a script.')
	action('OPERATOR ACTION — create the first propustka admin key', [
		`1. Open the propustka admin UI: ${url(`https://${hostname}`)}`,
		'2. Sign in with Cloudflare Access (you are a bootstrap admin from the deploy above).',
		'3. Create a SERVICE api-key with the admin role.',
		'4. Copy its client id + secret — you will paste them at the next prompt.',
	])
	detail("The wizard then mints vozka's OWN provisioning key with that admin key.")
}
