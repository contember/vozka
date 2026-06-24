/**
 * Shell-out helpers for the wizard, over `Bun.spawn`. Every orchestrated step (propustka deploy,
 * wrangler secret put, the vozka bootstrap/seed scripts, gh) goes through here so the rules are
 * enforced in ONE place:
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
	/** Optional stdin written to the child (used for `wrangler secret put`, which reads the value from stdin). */
	stdin?: string
}

/**
 * Run a step, STREAMING its stdout/stderr to this terminal so the operator watches the underlying
 * tool live (oblaka/wrangler/the bootstrap engine all print progress). Throws on a non-zero exit.
 * The thrown message names the command + exit code only.
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
 * need to parse a tool's output (e.g. the provisioning key the propustka script prints). Throws on a
 * non-zero exit; the captured stdout is NOT echoed by this helper (the caller decides what is safe to
 * show — the provisioning-key output carries a secret).
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
