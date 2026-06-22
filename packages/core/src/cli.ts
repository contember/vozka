#!/usr/bin/env bun
import type { AppConfig } from '@vozka/config'
import { resolve } from 'node:path'
import { deploy } from './deploy'
import type { DeployContext } from './types'

const USAGE = `vozka — deploy control plane

Usage:
  vozka deploy --env=<env> [--config=<path>]

Options:
  --env=<env>       Target environment (required), e.g. staging / production.
  --config=<path>   Path to the app config file (default: ./vozka.config.ts).
  -h, --help        Show this help.

Credentials are read from the environment:
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (required)
  PROPUSTKA_URL, PROPUSTKA_CLIENT_ID, PROPUSTKA_CLIENT_SECRET (optional)
  VOZKA_DOMAIN (optional)
`

interface ParsedArgs {
	command: string | undefined
	env: string | undefined
	config: string
	help: boolean
}

const parseArgs = (argv: string[]): ParsedArgs => {
	let command: string | undefined
	let env: string | undefined
	let config = './vozka.config.ts'
	let help = false

	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') {
			help = true
		} else if (arg.startsWith('--env=')) {
			env = arg.slice('--env='.length)
		} else if (arg.startsWith('--config=')) {
			config = arg.slice('--config='.length)
		} else if (!arg.startsWith('-') && command === undefined) {
			command = arg
		}
	}

	return { command, env, config, help }
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

const loadConfig = async (path: string): Promise<AppConfig> => {
	const absolute = resolve(process.cwd(), path)
	const module: { default?: unknown } = await import(absolute)
	const config = module.default
	if (!isAppConfig(config)) {
		return die(`Config at ${absolute} must \`export default defineApp({ ... })\``)
	}
	return config
}

const require = (name: string): string => {
	const value = process.env[name]
	if (value === undefined || value === '') {
		return die(`Missing ${name} environment variable`)
	}
	return value
}

const buildContext = (env: string): DeployContext => {
	return {
		env,
		domain: process.env['VOZKA_DOMAIN'],
		accountId: require('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: require('CLOUDFLARE_API_TOKEN'),
		propustkaUrl: process.env['PROPUSTKA_URL'],
		clientId: process.env['PROPUSTKA_CLIENT_ID'],
		clientSecret: process.env['PROPUSTKA_CLIENT_SECRET'],
		secrets: {},
		cwd: process.cwd(),
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

	const config = await loadConfig(args.config)
	const ctx = buildContext(env)

	const result = await deploy(config, ctx)
	console.log(`Deployed ${result.appId} to ${result.env}: ${result.status}`)
}

await main()
