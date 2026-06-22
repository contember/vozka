// The deploy engine's side-effecting collaborators, behind injectable interfaces. The orchestrator
// (`deploy.ts`) NEVER spawns a process, calls oblaka, or hits propustka directly — it goes through a
// `DeployRuntime`. Production wires the real implementations below; tests pass fakes. This is also
// the seam that makes a true dry-run possible: the orchestrator decides what to skip, the runtime
// just does what it's told.

import { reconcileAccess, reconcileSchema } from '@propustka/client'
import type { AppAccess, AppSchema } from '@vozka/config'
import { type Definition, deploy as oblakaDeploy, type DeployResult as OblakaDeployResult } from 'oblaka-iac'

/** A single shell-out: the command + its argv, the cwd, extra env, and optional stdin. */
export interface CommandSpec {
	/** Executable to run, e.g. `wrangler` or `bun`. */
	command: string
	/** Arguments, already split (never a single shell string — no shell, no injection). */
	args: string[]
	/** Working directory to run in. */
	cwd: string
	/** Extra environment variables layered over the parent process env. */
	env?: Record<string, string>
	/** Optional stdin piped to the child (used to feed secret values to `wrangler secret put`). */
	stdin?: string
}

/** The outcome of a shell-out. The runner resolves (never rejects) so the engine owns failure. */
export interface CommandResult {
	/** Process exit code (`0` is success). */
	exitCode: number
	/** Captured stdout. */
	stdout: string
	/** Captured stderr. */
	stderr: string
}

/** Runs shell commands (build + every `wrangler …`). The default impl spawns via Bun. */
export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>

/** What the engine asks of oblaka: provision a resource graph and hand back the wrangler config. */
export interface ProvisionInput {
	definition: Definition
	accountId: string
	apiToken: string
	env: string
	cwd: string
	/** When set, oblaka runs in plan-only mode (no remote, nothing written to disk). */
	dryRun: boolean
}

/** Provisions resources via oblaka. The default impl calls oblaka's programmatic `deploy()`. */
export type OblakaProvisioner = (input: ProvisionInput) => Promise<OblakaDeployResult>

/** Reconcile one app's authz vocabulary into propustka. */
export type SchemaReconciler = (input: { url: string; app: string; schema: AppSchema; clientId?: string; clientSecret?: string }) => Promise<void>

/** Reconcile one app's Cloudflare Access edge rules into propustka. */
export type AccessReconciler = (input: { url: string; app: string; access: AppAccess; clientId?: string; clientSecret?: string }) => Promise<void>

/** The full bundle of collaborators the orchestrator depends on. Tests substitute any subset. */
export interface DeployRuntime {
	runCommand: CommandRunner
	provision: OblakaProvisioner
	reconcileSchema: SchemaReconciler
	reconcileAccess: AccessReconciler
	/** Sink for human-readable progress / dry-run lines. Defaults to `console.log`. */
	log: (line: string) => void
}

// ── default (real) implementations ─────────────────────────────────────────────

/** Spawn a child process via Bun, capturing stdout/stderr; resolves with the exit code. */
const defaultRunCommand: CommandRunner = async (spec) => {
	const proc = Bun.spawn([spec.command, ...spec.args], {
		cwd: spec.cwd,
		env: { ...process.env, ...spec.env },
		stdin: spec.stdin === undefined ? 'inherit' : new TextEncoder().encode(spec.stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { exitCode, stdout, stderr }
}

const defaultProvision: OblakaProvisioner = (input) =>
	oblakaDeploy(input.definition, {
		accountId: input.accountId,
		apiToken: input.apiToken,
		env: input.env,
		cwd: input.cwd,
		// A real provision writes wrangler.jsonc + mutates Cloudflare; a dry-run does neither.
		remote: !input.dryRun,
		dryRun: input.dryRun,
	})

const defaultReconcileSchema: SchemaReconciler = (input) =>
	reconcileSchema({ url: input.url, app: input.app, schema: input.schema, accessClientId: input.clientId, accessClientSecret: input.clientSecret })

const defaultReconcileAccess: AccessReconciler = (input) =>
	reconcileAccess({ url: input.url, app: input.app, access: input.access, accessClientId: input.clientId, accessClientSecret: input.clientSecret })

/** The production runtime: real Bun spawn + real oblaka + real propustka, logging to stdout. */
export const defaultRuntime: DeployRuntime = {
	runCommand: defaultRunCommand,
	provision: defaultProvision,
	reconcileSchema: defaultReconcileSchema,
	reconcileAccess: defaultReconcileAccess,
	log: (line) => console.log(line),
}
