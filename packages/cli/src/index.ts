#!/usr/bin/env bun
/**
 * `@vozka/cli` entry point. The operator-facing CLI for standing up a CF account's vozka control-plane
 * base. Today it has one command — `init <account>` — which scaffolds the per-account `<org>/vozka-platform`
 * repo, creates the GitHub App, writes the GitHub Environment, and triggers the deploy (the real work runs
 * in GitHub Actions). The deploy ENGINE lives in `@vozka/core`; this package is the bring-up surface.
 */

import { runInit } from './init'

const USAGE = `vozka — control-plane CLI

Usage:
  vozka init <account>    Bring up a CF account's vozka control-plane base (propustka + vozka-runner + vozka)

Examples:
  bunx @vozka/cli init mangoweb
`

async function main(): Promise<void> {
	const [command, account, ...rest] = process.argv.slice(2)
	if (command === undefined || command === 'help' || command === '-h' || command === '--help') {
		console.log(USAGE)
		return
	}
	if (command === 'init') {
		if (account === undefined || account === '' || account.startsWith('-')) {
			throw new Error('`init` requires an account name, e.g. `vozka init mangoweb`')
		}
		if (rest.length > 0) {
			throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`)
		}
		await runInit(account)
		return
	}
	throw new Error(`Unknown command: ${command}\n${USAGE}`)
}

main().catch((error: unknown) => {
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
