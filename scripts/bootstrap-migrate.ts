#!/usr/bin/env bun
/**
 * Interactive bootstrap wizard — MIGRATE flow: propustka is ALREADY live (contember, mangoweb), and we
 * are bringing vozka up alongside it. This is the common case for an existing Cloudflare account that
 * already runs propustka as its Access/authz front door.
 *
 * It ORCHESTRATES the existing operator scripts (the `vozka platform deploy` command, scripts/seed.ts,
 * propustka's provision-key.ts) — it never re-implements their deploy logic. See the wizard/ modules.
 *
 * What it does, in order:
 *   1. collect vozka's domain, the propustka URL, the GitHub org, and the first-admin email(s),
 *   2. take the CLOUDFLARE_API_TOKEN, verify it, resolve the account, check the zone,
 *   3. obtain vozka's propustka provisioning key (paste an existing one, or mint a new one with an
 *      admin Access service token),
 *   4. run the shared vozka bring-up (vault key + GitHub App + configure the platform repo + trigger CI).
 *
 * Run it from a laptop with the operator creds in hand — NOTHING is committed or logged. No flags.
 *   bun run scripts/bootstrap-migrate.ts
 */

import { findZone, resolveAccountId, verifyToken } from './wizard/cloudflare'
import { fromEnv, persistEnv } from './wizard/envfile'
import { detail, info, ok, step, warn } from './wizard/log'
import { confirm, retry, secret, secretOrEnv, select, text } from './wizard/prompt'
import { mintProvisioningKey, type ProvisioningKey } from './wizard/propustka'
import { collectBringupCommon, runVozkaBringup } from './wizard/vozka-bringup'

async function main(): Promise<void> {
	console.log('\nvozka bootstrap — MIGRATE flow (propustka already live)\n')

	// 1. The vozka-portion inputs (domain, org, first admins, repo URLs, env).
	step('Collect vozka details')
	const common = await collectBringupCommon({ githubOrg: 'contember' })
	const propustkaUrl = await retry('propustka base URL', async () => {
		const raw = (await text('propustka base URL (e.g. https://propustka.example.com)')).replace(/\/+$/, '')
		if (!URL.canParse(raw)) {
			throw new Error(`Not a valid URL: ${raw === '' ? '(empty)' : raw}`)
		}
		return raw
	})

	// 2. The CF token: verify → resolve account → zone check. This ONE token is both the deploy cred
	//    and vozka's runtime CLOUDFLARE_API_TOKEN secret (single-account).
	step('Cloudflare API token')
	info("This token authenticates the deploy AND becomes vozka's runtime CLOUDFLARE_API_TOKEN secret.")
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
	const zone = await findZone(apiToken, common.vozkaDomain).catch(() => null)
	if (zone === null) {
		warn(`No Cloudflare zone found for ${common.vozkaDomain} — a custom-domain bind would fail. Add the zone before the real deploy.`)
	} else {
		ok(`Zone found: ${zone.name}`)
	}

	// 3. The propustka provisioning key — paste an existing one, or mint one with an admin token.
	const key = await obtainProvisioningKey(propustkaUrl)

	// 4. Hand off to the shared bring-up.
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
		platformRepo: common.platformRepo,
		installRepos: common.installRepos,
	})

	console.log('\nDone. vozka is live and migrated alongside propustka.\n')
}

/**
 * Obtain vozka's propustka provisioning key: either paste an existing client id/secret, or mint a new
 * one by shelling out to propustka's provision-key.ts with an ADMIN Access service token. The admin
 * token (and the minted key) are read via hidden prompts and never logged.
 */
async function obtainProvisioningKey(propustkaUrl: string): Promise<ProvisioningKey> {
	step("propustka provisioning key (vozka's PROPUSTKA_CLIENT_ID / _SECRET)")
	const envId = fromEnv('PROPUSTKA_CLIENT_ID')
	const envSecret = fromEnv('PROPUSTKA_CLIENT_SECRET')
	if (envId !== undefined && envSecret !== undefined) {
		ok('Reusing the propustka provisioning key from .env (resume).')
		return { clientId: envId, clientSecret: envSecret }
	}
	const mode = await select('How should vozka get its propustka provisioning key?', [
		{ label: 'Mint a new one now (needs an admin Access service token)', value: 'mint' },
		{ label: 'Paste an existing client id + secret', value: 'paste' },
	])
	const key = mode === 'paste' ? await pasteProvisioningKey() : await mintInteractive(propustkaUrl)
	await persistEnv('PROPUSTKA_CLIENT_ID', key.clientId)
	await persistEnv('PROPUSTKA_CLIENT_SECRET', key.clientSecret)
	ok('Provisioning key saved to .env (resume-safe).')
	return key
}

/** Paste an existing propustka client id + secret (hidden prompts). */
async function pasteProvisioningKey(): Promise<ProvisioningKey> {
	const clientId = (await secret('PROPUSTKA_CLIENT_ID')).trim()
	const clientSecret = (await secret('PROPUSTKA_CLIENT_SECRET')).trim()
	return { clientId, clientSecret }
}

/** Mint a fresh provisioning key by shelling out to propustka with an admin Access service token. */
async function mintInteractive(propustkaUrl: string): Promise<ProvisioningKey> {
	const propustkaPath = await text('local propustka checkout path', '/home/matej21/projects/oss/propustka')
	const confirmed = await confirm('Mint a new vozka provisioning key in propustka now?', true)
	if (!confirmed) {
		throw new Error('Aborted before minting the provisioning key.')
	}
	info('Paste an ADMIN Access service token (authorizes minting via propustka /admin/api-keys).')
	return retry('Mint provisioning key', async () => {
		const adminClientId = (await secret('PROPUSTKA_ACCESS_CLIENT_ID (admin)')).trim()
		const adminClientSecret = (await secret('PROPUSTKA_ACCESS_CLIENT_SECRET (admin)')).trim()
		return mintProvisioningKey({ propustkaPath, propustkaUrl, adminClientId, adminClientSecret })
	})
}

main().catch((error: unknown) => {
	detail('')
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
