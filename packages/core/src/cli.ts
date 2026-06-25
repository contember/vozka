#!/usr/bin/env bun
import { resolve } from 'node:path'
import type { AppConfig } from 'vozka-config'
import { parseArgs, type ParsedArgs, platformComponents } from './cli-args'
import { deploy } from './deploy'
import type { DeployContext, DeployResult } from './types'

const USAGE = `vozka — deploy control plane

Usage:
  vozka deploy --env=<env> [--config=<path>] [--dry-run]
  vozka platform deploy [--env=<env>] --runner-config=<path> --worker-config=<path> [--build-runner-image] [--dry-run]

Commands:
  deploy            Deploy ONE app config (build → provision → migrate → deploy-worker → reconcile → secrets).
  platform deploy   Bring up / redeploy the control-plane BASE for an account, in order: vozka-runner (the
                    deploy executor) THEN vozka (the control plane). Idempotent — safe to re-run for a first
                    bring-up OR a routine redeploy. Each component deploys via the SAME engine as \`deploy\`,
                    gathering its own pipeline.secrets/vars from the environment. Run it from a checkout of
                    the vozka repo (the configs live in it).

Options:
  --env=<env>            Target environment. \`deploy\`: required. \`platform deploy\`: defaults to \`prod\`.
  --config=<path>        (deploy) Path to the app config file (default: ./vozka.config.ts).
  --runner-config=<path> (platform) vozka-runner's config, e.g. packages/runner/vozka-runner.config.ts.
  --worker-config=<path> (platform) vozka's config, e.g. packages/worker/vozka.config.ts.
  --build-runner-image   (platform) Build + push the runner container image from its Dockerfile (sets
                         RUNNER_BUILD=1) instead of referencing the pinned registry image. Needed for the
                         FIRST bring-up on an account (the image isn't in that account's registry yet) or a
                         deliberate rebuild. Requires a docker host (CI runners have one).
  --dry-run              Plan-only: oblaka runs in dryRun, no real wrangler deploy / secret put / reconcile.
  -h, --help             Show this help.

Credentials are read from the environment:
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (required)
  PROPUSTKA_URL, PROPUSTKA_CLIENT_ID, PROPUSTKA_CLIENT_SECRET (optional)
  VOZKA_DOMAIN (optional; the control-plane host for \`platform deploy\`)

Secrets declared in \`pipeline.secrets\` are read from the environment by name.
Non-secret vars declared in \`pipeline.vars\` are likewise read from the environment by name.
`

const die = (message: string): never => {
	console.error(message)
	process.exit(1)
}

const isAppConfig = (value: unknown): value is AppConfig => {
	return (
		typeof value === 'object'
		&& value !== null
		&& 'id' in value
		&& typeof value.id === 'string'
		&& 'resources' in value
		&& typeof value.resources === 'function'
	)
}

const loadConfig = async (path: string): Promise<{ config: AppConfig; dir: string }> => {
	const absolute = resolve(process.cwd(), path)
	const module: { default?: unknown } = await import(absolute)
	const config = module.default
	if (!isAppConfig(config)) {
		return die(`Config at ${absolute} must \`export default defineApp({ ... })\``)
	}
	// Relative paths (workerDir, build) resolve against the config file's directory, not the cwd.
	return { config, dir: resolve(absolute, '..') }
}

const requireEnv = (name: string): string => {
	const value = process.env[name]
	if (value === undefined || value === '') {
		return die(`Missing ${name} environment variable`)
	}
	return value
}

/** Gather each declared secret's value from the environment (by its own name). */
const gatherSecrets = (config: AppConfig): Record<string, string> => {
	const secrets: Record<string, string> = {}
	for (const name of config.pipeline?.secrets ?? []) {
		const value = process.env[name]
		if (value !== undefined && value !== '') {
			secrets[name] = value
		}
	}
	return secrets
}

/** Gather each declared NON-secret deploy var's value from the environment (by its own name). The
 * runner forwarded these into the child env; the engine re-injects + validates each declared one. */
const gatherVars = (config: AppConfig): Record<string, string> => {
	const vars: Record<string, string> = {}
	for (const name of config.pipeline?.vars ?? []) {
		const value = process.env[name]
		if (value !== undefined && value !== '') {
			vars[name] = value
		}
	}
	return vars
}

const buildContext = (config: AppConfig, env: string, dir: string, dryRun: boolean): DeployContext => {
	return {
		env,
		domain: process.env['VOZKA_DOMAIN'],
		// Creds are required even in dry-run (oblaka needs them to materialize the resource graph).
		accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
		propustkaUrl: process.env['PROPUSTKA_URL'],
		clientId: process.env['PROPUSTKA_CLIENT_ID'],
		clientSecret: process.env['PROPUSTKA_CLIENT_SECRET'],
		secrets: gatherSecrets(config),
		vars: gatherVars(config),
		cwd: dir,
		dryRun,
	}
}

const fmtDuration = (step: DeployResult['steps'][number]): string => {
	if (step.startedAt === undefined || step.finishedAt === undefined) {
		return ''
	}
	return ` (${step.finishedAt - step.startedAt}ms)`
}

const ICON: Record<string, string> = {
	pending: '·',
	running: '…',
	succeeded: '✓',
	failed: '✗',
	skipped: '∅',
}

const printResult = (result: DeployResult): void => {
	console.log(`\n${result.appId} → ${result.env}: ${result.status}`)
	for (const step of result.steps) {
		const icon = ICON[step.status] ?? '?'
		console.log(`  ${icon} ${step.spec.id} — ${step.status}${fmtDuration(step)}`)
		if (step.error !== undefined) {
			console.log(`      ${step.error}`)
		}
	}
}

/**
 * `platform deploy` — bring up / redeploy an account's control-plane BASE: vozka-runner THEN vozka, in
 * that order (vozka binds RUNNER_SVC → vozka-runner). Each component deploys via the same `deploy()` engine
 * the runner uses for apps, so it's identical to a normal deploy minus the running control plane — this is
 * what lets the per-account IaC pipeline deploy vozka WITHOUT vozka deploying itself. Idempotent.
 */
const runPlatformDeploy = async (args: ParsedArgs, env: string): Promise<void> => {
	const components = platformComponents(args.runnerConfig, args.workerConfig)

	// --build-runner-image: the runner config reads RUNNER_BUILD and builds its image from the Dockerfile
	// (pushed to THIS account's registry) instead of referencing the pinned registry ref. Set ONCE, up
	// front, so the runner component picks it up when its resources() materializes.
	if (args.buildRunnerImage) {
		process.env['RUNNER_BUILD'] = '1'
	}

	const rootCwd = process.cwd()
	for (const component of components) {
		const absolute = resolve(rootCwd, component.configPath)
		const dir = resolve(absolute, '..')
		// oblaka's deploy() READS the existing wrangler.jsonc relative to process.cwd() but WRITES it
		// relative to ctx.cwd; chdir so the two agree and the committed DO-migration history is preserved
		// (a fresh-gen shifts DO tags → wrangler 10074). Restored in finally. Mirrors bootstrap.ts.
		process.chdir(dir)
		try {
			const { config } = await loadConfig(absolute)
			const ctx = buildContext(config, env, dir, args.dryRun)
			console.log(`\n▸ ${component.label} → ${env}${args.dryRun ? ' (dry-run)' : ''} (idempotent — safe to re-run)`)
			const result = await deploy(config, ctx)
			printResult(result)
			if (result.status === 'failed') {
				// Stop the chain — never deploy vozka against a vozka-runner that failed to come up.
				process.exit(1)
			}
		} finally {
			process.chdir(rootCwd)
		}
	}
}

const main = async (): Promise<void> => {
	const args = parseArgs(process.argv.slice(2))

	if (args.help || args.command === undefined) {
		console.log(USAGE)
		process.exit(args.help ? 0 : 1)
	}

	// `platform deploy` — the control-plane base bring-up/redeploy (env defaults to `prod`, the account's
	// single env). Distinct from `deploy` (one app) which requires an explicit --env.
	if (args.command === 'platform' && args.subcommand === 'deploy') {
		await runPlatformDeploy(args, args.env ?? 'prod')
		return
	}

	if (args.command !== 'deploy') {
		const cmd = args.subcommand === undefined ? args.command : `${args.command} ${args.subcommand}`
		die(`Unknown command: ${cmd}\n\n${USAGE}`)
	}

	const env = args.env ?? die(`Missing --env=<env>\n\n${USAGE}`)

	const { config, dir } = await loadConfig(args.config)
	const ctx = buildContext(config, env, dir, args.dryRun)

	const result = await deploy(config, ctx)
	printResult(result)

	if (result.status === 'failed') {
		process.exit(1)
	}
}

await main().catch((err) => {
	// Any unexpected failure (config import error, a deploy-engine throw) becomes a clean exit 1 with a
	// readable message — not an unhandled promise rejection. Never print the raw error object: it could
	// carry a clone URL with an embedded token. The engine itself returns a `failed` result rather than
	// throwing, so reaching here means a fault outside the plan (loading config, building context).
	console.error(`vozka: ${err instanceof Error ? err.message : 'unknown error'}`)
	process.exit(1)
})
