#!/usr/bin/env bun
/**
 * One-time bring-up: deploy VOZKA ITSELF through vozka's own engine. This is the dogfood path — the
 * same `deploy()` (@vozka/core) that deploys every other app, fed vozka's own `vozka.config.ts`. It
 * sets `VOZKA_BOOTSTRAP_ADMINS` so the FIRST operator is an admin before propustka has any grant for
 * them (src/iam.ts `withBootstrapAdmins`), breaking the chicken-and-egg of "you need to be authorized
 * to authorize yourself".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * ORDERING for a real bring-up on a fresh account (each step is a SEPARATE operator action):
 *
 *   1. propustka FIRST. vozka authenticates + authorizes through propustka, so propustka's admin
 *      front door must exist before vozka can reconcile its own Access/schema into it. Deploy
 *      propustka and bootstrap its OWN Access front door with ITS operator script — NOT re-implemented
 *      here:
 *        ~/projects/oss/propustka  →  bun run scripts/provision-access.ts
 *      (reads propustka's committed `packages/worker/propustka.access.ts`; see that script's header
 *      for CF_API_TOKEN / CF_ACCOUNT_ID / PROPUSTKA_HOSTNAME / PROPUSTKA_HUMAN_EMAIL_DOMAINS). Then
 *      mint a provisioning key for vozka (propustka `scripts/provision-key.ts`) and paste the
 *      resulting client id/secret into this script's PROPUSTKA_CLIENT_ID / PROPUSTKA_CLIENT_SECRET.
 *
 *   2. vozka SECOND — THIS script. Deploys vozka via the engine with VOZKA_BOOTSTRAP_ADMINS set to the
 *      first operator's email(s). After it lands, that operator can sign in through Access and use the
 *      whole control plane as admin even though propustka has granted them nothing yet.
 *
 *   3. REGISTER apps THIRD — `scripts/seed.ts` (apps registry rows) so a GitHub push self-deploys
 *      them. Run it against the now-live control plane. (vozka is single-account — there is no
 *      account registry; the CF account/token are vozka's own Worker config, set in step 2.)
 *
 *   4. Once the operator has set up real propustka grants (admin role in the propustka admin UI),
 *      REMOVE VOZKA_BOOTSTRAP_ADMINS (set it back to `[]` and redeploy) so the escape hatch is closed
 *      and authorization is fully propustka-owned again.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * This script orchestrates ONLY step 2 (vozka's own deploy). Steps 1, 3, 4 are operator actions,
 * documented above (1 + 4 link out to propustka; 3 is scripts/seed.ts).
 *
 * Required env (NEVER committed/logged — the operator holds these):
 *   CLOUDFLARE_ACCOUNT_ID                          — the SINGLE CF account vozka runs on + deploys into.
 *   CLOUDFLARE_API_TOKEN                           — the account-wide CF token. Authenticates THIS deploy
 *                                                    AND becomes vozka's runtime secret (it deploys every
 *                                                    other app with the same token — single-account).
 *   PROPUSTKA_URL, PROPUSTKA_CLIENT_ID, PROPUSTKA_CLIENT_SECRET — the one propustka's base URL + vozka's
 *                                                    provisioning key. Become vozka's runtime config so it
 *                                                    reconciles every app it deploys; also reconcile vozka.
 *   VOZKA_BOOTSTRAP_ADMINS                         — JSON array of the first operator email(s).
 *   VOZKA_DOMAIN                                   — vozka's hostname (drives Access destinations + vars).
 *   VOZKA_VAULT_KEY                                — the M4 vault master key (32 raw bytes, base64).
 *   GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET  — the GitHub App PEM key + webhook HMAC secret.
 * Optional:
 *   VOZKA_ENV (default `prod`).
 *
 * Usage:
 *   bun run scripts/bootstrap.ts            # real deploy (requires the env above)
 *   bun run scripts/bootstrap.ts --dry-run  # plan-only — builds the graph + walks every step, no CF
 */

import { deploy } from '@vozka/core'
import type { DeployContext } from '@vozka/core'
import { resolve } from 'node:path'

const DRY_RUN = process.argv.includes('--dry-run')

/** Read a required env var, or fail loudly (never proceed with a half-set deploy). */
function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === '') {
		throw new Error(`Missing required env var ${name} (see this script's header for the full list).`)
	}
	return value
}

/** Optional env var (undefined when unset) — used for the propustka reconcile creds. */
function optional(name: string): string | undefined {
	const value = process.env[name]
	return value === undefined || value === '' ? undefined : value
}

async function main(): Promise<void> {
	// VOZKA_DOMAIN must be set before importing vozka.config (its `access` declaration throws at import
	// without it — same eager pattern as propustka/poplach's `propustka.access.ts`). Required either way.
	required('VOZKA_DOMAIN')
	// VOZKA_BOOTSTRAP_ADMINS is the whole point of the bootstrap — refuse to run without the first admin
	// (an empty deploy here would lock the operator out: nobody can authorize, including themselves).
	const bootstrapAdmins = required('VOZKA_BOOTSTRAP_ADMINS')

	// Import AFTER the env guards: vozka.config materializes `access` at import (needs VOZKA_DOMAIN).
	const { default: config } = await import('../vozka.config')

	const env = optional('VOZKA_ENV') ?? 'prod'

	// The secret VALUES vozka needs at deploy, gathered by the SAME names the config declares in
	// `pipeline.secrets`. Read from the environment; never inlined, never logged. CLOUDFLARE_API_TOKEN +
	// the propustka provisioning key are vozka's RUNTIME platform creds (it injects them into every
	// deploy it runs), so they are required Worker secrets — a vozka without them can't deploy/reconcile.
	const secrets: Record<string, string> = {
		VOZKA_VAULT_KEY: required('VOZKA_VAULT_KEY'),
		GITHUB_APP_PRIVATE_KEY: required('GITHUB_APP_PRIVATE_KEY'),
		GITHUB_WEBHOOK_SECRET: required('GITHUB_WEBHOOK_SECRET'),
		CLOUDFLARE_API_TOKEN: required('CLOUDFLARE_API_TOKEN'),
		PROPUSTKA_CLIENT_ID: required('PROPUSTKA_CLIENT_ID'),
		PROPUSTKA_CLIENT_SECRET: required('PROPUSTKA_CLIENT_SECRET'),
	}

	const ctx: DeployContext = {
		env,
		domain: required('VOZKA_DOMAIN'),
		accountId: required('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: secrets.CLOUDFLARE_API_TOKEN,
		propustkaUrl: required('PROPUSTKA_URL'),
		clientId: secrets.PROPUSTKA_CLIENT_ID,
		clientSecret: secrets.PROPUSTKA_CLIENT_SECRET,
		secrets,
		// vozka.config + its workerDir resolve against packages/worker (this script's parent dir).
		cwd: resolve(import.meta.dir, '..'),
		dryRun: DRY_RUN,
	}

	// The bootstrap admin list is set on the deploy's environment (the engine's `wrangler secret put` /
	// var path picks up vozka.config's `VOZKA_BOOTSTRAP_ADMINS` var, which reads process.env). We log
	// only the COUNT — never the emails or any secret value.
	const adminCount = (() => {
		try {
			const parsed: unknown = JSON.parse(bootstrapAdmins)
			return Array.isArray(parsed) ? parsed.length : 0
		} catch {
			return 0
		}
	})()
	console.log(`Bootstrapping vozka → ${env}${DRY_RUN ? ' (dry-run)' : ''} with ${adminCount} bootstrap admin(s).`)

	const result = await deploy(config, ctx)

	console.log(`\n${result.appId} → ${result.env}: ${result.status}`)
	for (const step of result.steps) {
		console.log(`  ${step.status.padEnd(10)} ${step.spec.id}${step.error !== undefined ? ` — ${step.error}` : ''}`)
	}
	if (result.status === 'failed') {
		process.exit(1)
	}

	console.log('\nNext: register apps (scripts/seed.ts), then close the escape hatch (set')
	console.log('VOZKA_BOOTSTRAP_ADMINS=[] and redeploy once propustka grants the operator admin).')
}

main().catch((error: unknown) => {
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
