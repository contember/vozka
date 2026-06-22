#!/usr/bin/env bun
import type { AppConfig } from '@vozka/config'
import { resolve } from 'node:path'
import { deploy } from './deploy'
import type { DeployContext, DeployResult } from './types'

const USAGE = `vozka — deploy control plane

Usage:
  vozka deploy --env=<env> [--config=<path>] [--dry-run]

Options:
  --env=<env>       Target environment (required), e.g. staging / production.
  --config=<path>   Path to the app config file (default: ./vozka.config.ts).
  --dry-run         Build + print the plan and walk every step in plan-only mode:
                    oblaka runs with dryRun (no remote, no writes) and no real
                    wrangler deploy / secret put / propustka reconcile happens.
  -h, --help        Show this help.

Credentials are read from the environment:
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (required)
  PROPUSTKA_URL, PROPUSTKA_CLIENT_ID, PROPUSTKA_CLIENT_SECRET (optional)
  VOZKA_DOMAIN (optional)

Secrets declared in \`pipeline.secrets\` are read from the environment by name.
`

interface ParsedArgs {
	command: string | undefined
	env: string | undefined
	config: string
	dryRun: boolean
	help: boolean
}

const parseArgs = (argv: string[]): ParsedArgs => {
	let command: string | undefined
	let env: string | undefined
	let config = './vozka.config.ts'
	let dryRun = false
	let help = false

	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') {
			help = true
		} else if (arg === '--dry-run') {
			dryRun = true
		} else if (arg.startsWith('--env=')) {
			env = arg.slice('--env='.length)
		} else if (arg.startsWith('--config=')) {
			config = arg.slice('--config='.length)
		} else if (!arg.startsWith('-') && command === undefined) {
			command = arg
		}
	}

	return { command, env, config, dryRun, help }
}

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

const main = async (): Promise<void> => {
	const args = parseArgs(process.argv.slice(2))

	if (args.help || args.command === undefined) {
		console.log(USAGE)
		process.exit(args.help ? 0 : 1)
	}

	if (args.command !== 'deploy') {
		die(`Unknown command: ${args.command}\n\n${USAGE}`)
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
