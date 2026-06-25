#!/usr/bin/env bun
/**
 * Interactive bootstrap wizard — FRESH flow: NOTHING exists on the account yet. propustka must come up
 * FIRST (vozka authenticates + authorizes through it), then vozka alongside it. This is the
 * full-account cold start.
 *
 * It ORCHESTRATES the existing operator scripts — propustka's deploy.yml step sequence (replicated as
 * shell-outs), propustka's provision-key.ts, and vozka's own `platform deploy` command + scripts/seed.ts.
 * It never re-implements deploy logic. See the wizard/ modules.
 *
 * What it does, in order:
 *   1. confirm a local propustka checkout path,
 *   2. collect propustka inputs (hostname, team, access apps, human audience, first admin) + the CF
 *      token (verify + resolve account),
 *   3. deploy propustka from nothing (deployPropustkaFresh),
 *   4. hand off the chicken-and-egg FIRST admin key to the operator (browser), then mint vozka's key,
 *   5. run the SAME shared vozka bring-up as the migrate flow.
 *
 * Run it from a laptop with the operator creds in hand — NOTHING is committed or logged. No flags.
 *   bun run scripts/bootstrap-fresh.ts
 */

import { findZone, resolveAccountId, verifyToken } from './wizard/cloudflare'
import { fromEnv, persistEnv } from './wizard/envfile'
import { detail, info, ok, step, warn } from './wizard/log'
import { confirm, retry, secret, secretOrEnv, select, text } from './wizard/prompt'
import { deployPropustkaFresh, firstAdminKeyHint, mintProvisioningKey, type ProvisioningKey } from './wizard/propustka'
import { collectBringupCommon, runVozkaBringup } from './wizard/vozka-bringup'

async function main(): Promise<void> {
	console.log('\nvozka bootstrap — FRESH flow (nothing exists — propustka first, then vozka)\n')

	// 1. Where is the propustka source? We shell out to its scripts.
	step('Locate the propustka checkout')
	const propustkaPath = await text('local propustka checkout path', '/home/matej21/projects/oss/propustka')

	// 2. propustka inputs + the CF token (verify + resolve account). The token is shared: it deploys
	//    propustka AND vozka, and becomes both Workers' runtime CF secret (single-account).
	step('Collect propustka details')
	const hostname = await text('propustka hostname (Custom Domain, e.g. propustka.example.com)')
	const team = await text('Cloudflare Access team URL (e.g. https://acme.cloudflareaccess.com)')
	const accessApps = await text('PROPUSTKA_ACCESS_APPS JSON (aud → appId; "{}" on first deploy)', '{}')
	const humanEmailDomains = await text('PROPUSTKA_HUMAN_EMAIL_DOMAINS (CSV or JSON array; required)')
	if (humanEmailDomains === '') {
		throw new Error('PROPUSTKA_HUMAN_EMAIL_DOMAINS is required — the central human Access audience.')
	}
	const humanEmails = await text('PROPUSTKA_HUMAN_EMAILS (optional; CSV or JSON array)', '')
	const propustkaAdmin = await text('First propustka admin email (PROPUSTKA_BOOTSTRAP_ADMINS)')
	const propustkaEnv = await select('propustka deploy environment', [
		{ label: 'prod', value: 'prod' },
		{ label: 'stage', value: 'stage' },
		{ label: 'mangoweb', value: 'mangoweb' },
	])

	step('Cloudflare API token')
	info("This token deploys propustka AND vozka, and becomes both Workers' runtime CF secret (single-account).")
	const verified = await retry('Cloudflare API token', async () => {
		const token = await secretOrEnv('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN')
		detail(`Resolving the Cloudflare account for this token (${token.length} chars)…`)
		const account = await resolveAccountId(token)
		if (await verifyToken(token, account.id)) {
			ok('Token verified (status active).')
		} else {
			warn('Could not pre-verify the token via the Cloudflare API.')
			detail('Expected for some account-owned tokens (invisible to /user/tokens/verify); the deploy validates it for real.')
			if (!(await confirm('Proceed anyway?', true))) {
				throw new Error('Token not verified — re-enter it.')
			}
		}
		return { token, account }
	})
	const apiToken = verified.token
	const account = verified.account
	ok(`Deploying into account: ${account.name} (${account.id})`)
	await persistEnv('CLOUDFLARE_ACCOUNT_ID', account.id)
	const zone = await findZone(apiToken, hostname).catch(() => null)
	if (zone === null) {
		warn(`No Cloudflare zone found for ${hostname} — a custom-domain bind would fail. Add the zone before the real deploy.`)
	} else {
		ok(`Zone found: ${zone.name}`)
	}

	// 3. Deploy propustka from nothing — gated behind an explicit confirm (it MUTATES the account).
	const go = await confirm(`Deploy propustka to "${propustkaEnv}" now (real Cloudflare changes)?`, false)
	if (!go) {
		throw new Error('Aborted before the propustka deploy.')
	}
	await deployPropustkaFresh({
		propustkaPath,
		accountId: account.id,
		apiToken,
		hostname,
		team,
		accessApps,
		humanEmailDomains,
		humanEmails,
		bootstrapAdmins: JSON.stringify([propustkaAdmin]),
		env: propustkaEnv,
	})

	// 4. The chicken-and-egg FIRST propustka admin key: minted by a human in the browser. Then mint
	//    vozka's provisioning key with it.
	const propustkaUrl = `https://${hostname}`
	const key = await obtainFreshProvisioningKey(propustkaPath, propustkaUrl, hostname)

	// 5. The vozka-portion inputs, then the SAME shared bring-up as the migrate flow.
	step('Collect vozka details')
	const common = await collectBringupCommon({ githubOrg: 'contember' })
	await runVozkaBringup({
		accountId: account.id,
		apiToken,
		vozkaDomain: common.vozkaDomain,
		propustkaUrl,
		propustkaClientId: key.clientId,
		propustkaClientSecret: key.clientSecret,
		bootstrapAdmins: common.bootstrapAdmins,
		githubOrg: common.githubOrg,
		env: common.env,
		installRepos: common.installRepos,
		vozkaRepoUrl: common.vozkaRepoUrl,
		propustkaRepoUrl: common.propustkaRepoUrl,
		propustkaAppDomain: hostname,
	})

	console.log('\nDone. propustka + vozka are both live on a fresh account.\n')
}

/**
 * The propustka provisioning key for the fresh flow: reuse from .env on a resume; otherwise hand off the
 * chicken-and-egg FIRST admin key (browser), mint, and persist it for resume-safety.
 */
async function obtainFreshProvisioningKey(propustkaPath: string, propustkaUrl: string, hostname: string): Promise<ProvisioningKey> {
	const envId = fromEnv('PROPUSTKA_CLIENT_ID')
	const envSecret = fromEnv('PROPUSTKA_CLIENT_SECRET')
	if (envId !== undefined && envSecret !== undefined) {
		ok('Reusing the propustka provisioning key from .env (resume).')
		return { clientId: envId, clientSecret: envSecret }
	}
	firstAdminKeyHint(hostname)
	const key = await retry('Mint provisioning key', async () => {
		const adminClientId = (await secret('PROPUSTKA_ACCESS_CLIENT_ID (the admin key you just created)')).trim()
		const adminClientSecret = (await secret('PROPUSTKA_ACCESS_CLIENT_SECRET (the admin key you just created)')).trim()
		return mintProvisioningKey({ propustkaPath, propustkaUrl, adminClientId, adminClientSecret })
	})
	await persistEnv('PROPUSTKA_CLIENT_ID', key.clientId)
	await persistEnv('PROPUSTKA_CLIENT_SECRET', key.clientSecret)
	ok('Provisioning key saved to .env (resume-safe).')
	return key
}

main().catch((error: unknown) => {
	detail('')
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
