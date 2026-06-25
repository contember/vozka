// Argument parsing for the `vozka` CLI — pure + side-effect-free, so it's unit-testable WITHOUT running
// the CLI (cli.ts executes main() at import). cli.ts owns the I/O (loading configs, deploying); this owns
// only the shape of the parsed command line + the platform component ordering.

export interface ParsedArgs {
	/** First positional, e.g. `deploy` or `platform`. */
	command: string | undefined
	/** Second positional, e.g. the `deploy` in `platform deploy`. */
	subcommand: string | undefined
	env: string | undefined
	/** (deploy) the single app config path. */
	config: string
	/** (platform deploy) vozka-runner's config path. */
	runnerConfig: string | undefined
	/** (platform deploy) vozka's config path. */
	workerConfig: string | undefined
	/** (platform deploy) build + push the runner image from its Dockerfile instead of the pinned ref. */
	buildRunnerImage: boolean
	dryRun: boolean
	help: boolean
}

export const parseArgs = (argv: string[]): ParsedArgs => {
	let command: string | undefined
	let subcommand: string | undefined
	let env: string | undefined
	let config = './vozka.config.ts'
	let runnerConfig: string | undefined
	let workerConfig: string | undefined
	let buildRunnerImage = false
	let dryRun = false
	let help = false

	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') {
			help = true
		} else if (arg === '--dry-run') {
			dryRun = true
		} else if (arg === '--build-runner-image') {
			buildRunnerImage = true
		} else if (arg.startsWith('--env=')) {
			env = arg.slice('--env='.length)
		} else if (arg.startsWith('--config=')) {
			config = arg.slice('--config='.length)
		} else if (arg.startsWith('--runner-config=')) {
			runnerConfig = arg.slice('--runner-config='.length)
		} else if (arg.startsWith('--worker-config=')) {
			workerConfig = arg.slice('--worker-config='.length)
		} else if (!arg.startsWith('-')) {
			// First bare positional is the command, the second the subcommand (e.g. `platform deploy`).
			if (command === undefined) {
				command = arg
			} else if (subcommand === undefined) {
				subcommand = arg
			}
		}
	}

	return { command, subcommand, env, config, runnerConfig, workerConfig, buildRunnerImage, dryRun, help }
}

export interface PlatformComponent {
	label: string
	configPath: string
}

/**
 * The control-plane BASE components, in DEPLOY ORDER: vozka-runner FIRST, then vozka. vozka binds
 * `RUNNER_SVC` → vozka-runner, so the runner must already exist or `wrangler deploy` of vozka fails to
 * resolve the service binding (CF 10143). Pure — no I/O — so the ordering + required-args are unit-testable.
 */
export const platformComponents = (runnerConfig: string | undefined, workerConfig: string | undefined): PlatformComponent[] => {
	if (runnerConfig === undefined || runnerConfig === '') {
		throw new Error('Missing --runner-config=<path> for `platform deploy`')
	}
	if (workerConfig === undefined || workerConfig === '') {
		throw new Error('Missing --worker-config=<path> for `platform deploy`')
	}
	return [
		{ label: 'vozka-runner', configPath: runnerConfig },
		{ label: 'vozka', configPath: workerConfig },
	]
}
