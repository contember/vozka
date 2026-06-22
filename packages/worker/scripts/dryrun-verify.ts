#!/usr/bin/env bun
/**
 * Offline full-path proof that vozka can deploy ITSELF: run the engine's `deploy()` in dry-run against
 * vozka's OWN `vozka.config.ts`, substituting just the oblaka provisioner (oblaka's real `deploy()`
 * hits the cf-state KV even in dryRun — the same injection seam packages/core/fixtures/dryrun-verify.ts
 * uses). Everything else is the real engine + the real vozka config. NO Cloudflare, NO propustka, NO
 * real creds. Proves the plan builds and every step walks in plan-only mode.
 *
 *   bun run scripts/dryrun-verify.ts
 */
import { deploy } from '@vozka/core'
import type { DeployContext, DeployRuntime } from '@vozka/core'
import { defaultRuntime } from '@vozka/core'
import { resolve } from 'node:path'

// vozka.config's `access` declaration throws without VOZKA_DOMAIN (eager, like propustka/poplach) —
// set it before importing the config. This is the dry-run/offline stand-in for the real deploy var.
process.env['VOZKA_DOMAIN'] = process.env['VOZKA_DOMAIN'] ?? 'vozka.stage.example.com'

const { default: config } = await import('../vozka.config')

// Substitute ONLY the oblaka provisioner; the rest of the engine runs for real (in dry-run mode).
const runtime: DeployRuntime = {
	...defaultRuntime,
	provision: (input) => {
		console.log(`  [fake-oblaka] materialized vozka graph for ${input.env}, dryRun=${input.dryRun}`)
		return Promise.resolve({
			wranglerConfigs: [{ path: 'wrangler.jsonc', config: { name: `${input.env}-vozka` }, content: '{}' }],
			wranglerConfig: { name: `${input.env}-vozka` },
		})
	},
}

const ctx: DeployContext = {
	env: 'stage',
	domain: process.env['VOZKA_DOMAIN'],
	accountId: 'dummy-acc',
	apiToken: 'dummy-tok',
	propustkaUrl: 'https://iam.example.com',
	clientId: 'cid',
	clientSecret: 'csec',
	// The runtime worker secrets vozka.config declares in pipeline.secrets — dummy values offline.
	secrets: {
		VOZKA_VAULT_KEY: 'dummy-vault-key',
		GITHUB_APP_PRIVATE_KEY: 'dummy-pem',
		GITHUB_WEBHOOK_SECRET: 'dummy-hmac',
	},
	cwd: resolve(import.meta.dir, '..'),
	dryRun: true,
}

const result = await deploy(config, ctx, runtime)
console.log('\n=== RESULT ===')
console.log('overall:', result.status)
for (const s of result.steps) {
	console.log(' ', s.status.padEnd(10), s.spec.id)
}
process.exit(result.status === 'failed' ? 1 : 0)
