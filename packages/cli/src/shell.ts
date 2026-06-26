/**
 * Shell-out helpers for the CLI, over `Bun.spawn`. Every orchestrated step (git, gh, the deploy
 * trigger) goes through here so the rules are enforced in ONE place:
 *   - argv is passed verbatim (no shell) — nothing interpolated can be a metacharacter,
 *   - the child gets ONLY `process.env` + the explicit `env` the step needs,
 *   - on a non-zero exit we throw a SHORT message naming the command — never the child env, never a
 *     secret value, never the raw error object (which could carry a token-bearing URL).
 */

/** A child step to run: the command + args, its cwd, and the extra env it needs (merged over process.env). */
export interface ShellStep {
	command: string
	args: string[]
	cwd: string
	/** Extra env vars for this child only. Secret VALUES live here and nowhere else. */
	env?: Record<string, string>
	/** Optional stdin written to the child (used for `gh secret set`, which reads the value from stdin). */
	stdin?: string
}

/**
 * Run a step, STREAMING its stdout/stderr to this terminal so the operator watches the underlying
 * tool live (git/gh print progress). Throws on a non-zero exit. The thrown message names the command
 * + exit code only.
 */
export async function run(step: ShellStep): Promise<void> {
	const proc = Bun.spawn([step.command, ...step.args], {
		cwd: step.cwd,
		env: { ...process.env, ...step.env },
		stdin: step.stdin !== undefined ? new TextEncoder().encode(step.stdin) : 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	})
	const exitCode = await proc.exited
	if (exitCode !== 0) {
		throw new Error(`\`${step.command} ${step.args.join(' ')}\` failed (exit ${exitCode}).`)
	}
}

/**
 * Run a step and CAPTURE its stdout (returned), while streaming stderr to this terminal. Used when we
 * need to parse a tool's output (e.g. `gh repo view`). Throws on a non-zero exit; the captured stdout
 * is NOT echoed by this helper.
 */
export async function capture(step: ShellStep): Promise<string> {
	const proc = Bun.spawn([step.command, ...step.args], {
		cwd: step.cwd,
		env: { ...process.env, ...step.env },
		stdin: step.stdin !== undefined ? new TextEncoder().encode(step.stdin) : 'ignore',
		stdout: 'pipe',
		stderr: 'inherit',
	})
	const stdout = await new Response(proc.stdout).text()
	const exitCode = await proc.exited
	if (exitCode !== 0) {
		throw new Error(`\`${step.command} ${step.args.join(' ')}\` failed (exit ${exitCode}).`)
	}
	return stdout
}

/** Run a step quietly: no stdout/stderr to the terminal, returns the exit code. For existence probes. */
export async function probe(step: ShellStep): Promise<number> {
	const proc = Bun.spawn([step.command, ...step.args], {
		cwd: step.cwd,
		env: { ...process.env, ...step.env },
		stdout: 'ignore',
		stderr: 'ignore',
	})
	return proc.exited
}
