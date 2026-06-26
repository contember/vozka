/**
 * Write the collected configuration into the base repo's GitHub **Environment** (not repo-level), so the
 * platform pipeline reads it per-environment. Secret VALUES go to `gh secret set --env` over STDIN (gh does
 * the libsodium encryption; the value never hits argv or a log line); non-secret values go to
 * `gh variable set --env --body`. The environment itself is created (idempotent PUT) first.
 */

import { ok, step, warn } from './log'
import { capture, run } from './shell'

/** A harmless cwd anchor — `gh` ignores cwd when `--repo` is given. */
const ANCHOR = process.cwd()

export interface EnvironmentConfig {
	repo: string
	environment: string
	/** Secret name → value (written via `gh secret set`). */
	secrets: Record<string, string>
	/** Variable name → value (written via `gh variable set`). */
	vars: Record<string, string>
}

/** Create the GitHub Environment and populate its secrets + variables. */
export async function configureEnvironment(config: EnvironmentConfig): Promise<void> {
	const { repo, environment, secrets, vars } = config
	step(`Configure the ${environment} GitHub Environment on ${repo}`)

	// Idempotent create (PUT returns the env object on stdout — captured + discarded, never logged).
	await capture({ command: 'gh', args: ['api', '-X', 'PUT', `repos/${repo}/environments/${environment}`], cwd: ANCHOR })
	ok(`Environment ${environment} ready.`)

	for (const [name, value] of Object.entries(secrets)) {
		if (value === '') {
			warn(`Skipping secret ${name} — no value (the workflow will fail without it; set it manually).`)
			continue
		}
		await run({ command: 'gh', args: ['secret', 'set', name, '--repo', repo, '--env', environment], cwd: ANCHOR, stdin: value })
		ok(`secret ${name} set`)
	}
	for (const [name, value] of Object.entries(vars)) {
		await run({ command: 'gh', args: ['variable', 'set', name, '--repo', repo, '--env', environment, '--body', value], cwd: ANCHOR })
		ok(`variable ${name} set`)
	}
}

/** Trigger the platform workflow (the real deploy runs in GitHub Actions). */
export async function triggerPlatformWorkflow(repo: string, buildRunnerImage: boolean): Promise<void> {
	const args = ['workflow', 'run', 'platform.yml', '--repo', repo]
	if (buildRunnerImage) {
		args.push('-f', 'build_runner_image=true')
	}
	await run({ command: 'gh', args, cwd: ANCHOR })
}
