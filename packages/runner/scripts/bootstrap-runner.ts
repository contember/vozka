#!/usr/bin/env bun
/**
 * Deploy VOZKA-RUNNER — the deploy executor, OUT-OF-BAND. vozka-runner can't be deployed through vozka's
 * runner-path the way every other app is: deploying vozka-runner resets vozka-runner's own container DO
 * mid-deploy (the same self-reset the split exists to avoid, just turned on itself). So it's deployed by
 * its OWN engine on a docker host, exactly like vozka's `scripts/bootstrap.ts` deploys vozka — the
 * difference is vozka-runner is INFRA: no propustka reconcile (no access/schema), no runtime secrets
 * (every credential arrives per-run in the RunnerJob over the binding). It changes rarely — only when
 * the relay / container / runner image changes.
 *
 * IDEMPOTENT — safe to re-run (oblaka provision adopts existing resources; `wrangler deploy` overwrites).
 *
 * THE CONTAINER IMAGE:
 *   - Normal redeploy: references the pre-built image PINNED in `image.json` (no docker needed).
 *   - First bring-up / image rebuild: set `RUNNER_BUILD=1` AND run on a DOCKER HOST — wrangler builds the
 *     image from the Dockerfile and pushes it. (CI normally builds + pins the image; this is the manual path.)
 *
 * Required env (NEVER committed/logged — the operator holds these):
 *   CLOUDFLARE_ACCOUNT_ID  — the SINGLE CF account vozka-runner runs on (must match vozka's, so the
 *                            adopted RUN_LOGS / DB resolve to the SAME `<env>-vozka*` resources).
 *   CLOUDFLARE_API_TOKEN   — the account-wide CF token that authenticates this deploy.
 * Optional:
 *   VOZKA_ENV    (default `prod`)  — must match the control plane's env so the shared D1/R2 adopt correctly.
 *   RUNNER_BUILD (set to `1`)      — build the container image from the Dockerfile (needs a docker host).
 *
 * Usage:
 *   bun run scripts/bootstrap-runner.ts                    # redeploy, references the pinned image (no docker)
 *   RUNNER_BUILD=1 bun run scripts/bootstrap-runner.ts     # build + push the image (docker host) then deploy
 *   bun run scripts/bootstrap-runner.ts --dry-run          # plan-only — graph + every step, no CF mutation
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

/** Optional env var (undefined when unset). */
function optional(name: string): string | undefined {
	const value = process.env[name]
	return value === undefined || value === '' ? undefined : value
}

async function main(): Promise<void> {
	const { default: config } = await import('../vozka-runner.config')
	const env = optional('VOZKA_ENV') ?? 'prod'

	const ctx: DeployContext = {
		env,
		accountId: required('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: required('CLOUDFLARE_API_TOKEN'),
		// No propustka coords (vozka-runner has no access/schema → no reconcile) and no runtime secrets.
		secrets: {},
		// The config + its workerDir resolve against packages/runner (this script's parent dir).
		cwd: resolve(import.meta.dir, '..'),
		dryRun: DRY_RUN,
	}

	console.log(`Deploying vozka-runner → ${env}${DRY_RUN ? ' (dry-run)' : ''} (idempotent — safe to re-run).`)
	if (process.env['RUNNER_BUILD'] === '1') {
		console.log('  RUNNER_BUILD=1 — building the container image from the Dockerfile (requires a docker host).')
	}

	// oblaka's programmatic deploy() READS the existing wrangler.jsonc relative to process.cwd() but
	// WRITES it relative to ctx.cwd; chdir into the package dir so they agree and the committed migration
	// history is preserved (see the same note in packages/worker/scripts/bootstrap.ts).
	process.chdir(ctx.cwd)
	const result = await deploy(config, ctx)

	console.log(`\n${result.appId} → ${result.env}: ${result.status}`)
	for (const step of result.steps) {
		console.log(`  ${step.status.padEnd(10)} ${step.spec.id}${step.error !== undefined ? ` — ${step.error}` : ''}`)
	}
	if (result.status === 'failed') {
		process.exit(1)
	}
}

main().catch((error: unknown) => {
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
