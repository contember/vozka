import { beforeEach, describe, expect, test } from 'bun:test'
import type { AppAccess, AppConfig, AppSchema } from 'vozka-config'
import { D1Database, Worker } from 'vozka-config'
import { deploy } from '../deploy'
import type { CommandResult, CommandSpec, DeployRuntime, ProvisionInput } from '../runtime'
import type { DeployContext } from '../types'

// The orchestrator routes EVERY side effect through a `DeployRuntime`. The tests pass a recording
// fake so we can assert which collaborator each step called, with what args, in what order — no
// process spawned, no oblaka, no propustka, no network.

interface Recorded {
	commands: CommandSpec[]
	provisions: ProvisionInput[]
	schemas: Array<{ url: string; app: string; schema: AppSchema; clientId?: string; clientSecret?: string }>
	accesses: Array<{ url: string; app: string; access: AppAccess; clientId?: string; clientSecret?: string }>
	logs: string[]
}

/** A recording runtime whose commands succeed by default; per-test overrides flip a command to fail. */
const makeRuntime = (
	rec: Recorded,
	overrides: { commandResult?: (spec: CommandSpec) => CommandResult; failProvision?: boolean } = {},
): DeployRuntime => ({
	runCommand: async (spec) => {
		rec.commands.push(spec)
		return overrides.commandResult?.(spec) ?? { exitCode: 0, stdout: '', stderr: '' }
	},
	provision: async (input) => {
		rec.provisions.push(input)
		if (overrides.failProvision) {
			throw new Error('oblaka boom')
		}
		return {
			wranglerConfigs: [{ path: 'wrangler.jsonc', config: { name: `${input.env}-app` }, content: '{}' }],
			wranglerConfig: { name: `${input.env}-app` },
		}
	},
	reconcileSchema: async (input) => {
		rec.schemas.push(input)
	},
	reconcileAccess: async (input) => {
		rec.accesses.push(input)
	},
	log: (line) => {
		rec.logs.push(line)
	},
})

const fresh = (): Recorded => ({ commands: [], provisions: [], schemas: [], accesses: [], logs: [] })

const SCHEMA: AppSchema = { scopes: [], actions: [], roles: {} }
const ACCESS: AppAccess = { apps: [] }

/** Build a config; by default the simplest possible app (just resources). */
const makeConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
	id: 'demo',
	resources: () => new Worker({ dir: '.', name: 'demo', compatibility_flags: ['nodejs_compat'], bindings: {}, main: 'src/index.ts' }),
	...overrides,
})

/** Build a context; creds always present, propustka/dryRun per test. */
const makeCtx = (overrides: Partial<DeployContext> = {}): DeployContext => ({
	env: 'stage',
	accountId: 'acc-1',
	apiToken: 'tok-1',
	secrets: {},
	cwd: '/work',
	...overrides,
})

let rec: Recorded
beforeEach(() => {
	rec = fresh()
})

describe('plan derivation', () => {
	test('minimal config: provision-resources then deploy-worker', async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeRuntime(rec))
		expect(result.plan.steps.map((s) => s.kind)).toEqual(['provision-resources', 'deploy-worker'])
	})

	test('build step only when pipeline.build is set', async () => {
		const result = await deploy(makeConfig({ pipeline: { build: 'bun run build' } }), makeCtx(), makeRuntime(rec))
		expect(result.plan.steps.map((s) => s.kind)).toEqual(['build', 'provision-resources', 'deploy-worker'])
	})

	test('migrate step per D1 database that declares migrations', async () => {
		const config = makeConfig({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: {
						DB: new D1Database({ name: 'maindb', migrationsDir: './migrations' }),
						CACHE: new D1Database({ name: 'cache' }), // no migrationsDir → no migrate step
					},
				}),
		})
		const result = await deploy(config, makeCtx(), makeRuntime(rec))
		expect(result.plan.steps.map((s) => s.id)).toEqual(['provision-resources', 'migrate:DB', 'deploy-worker'])
	})

	test('reconcile-schema/access only with both the declaration AND propustkaUrl', async () => {
		const config = makeConfig({ schema: SCHEMA, access: ACCESS })

		const withoutUrl = await deploy(config, makeCtx(), makeRuntime(fresh()))
		expect(withoutUrl.plan.steps.map((s) => s.kind)).toEqual(['provision-resources', 'deploy-worker'])

		const withUrl = await deploy(config, makeCtx({ propustkaUrl: 'https://iam.example.com' }), makeRuntime(rec))
		expect(withUrl.plan.steps.map((s) => s.kind)).toEqual(['provision-resources', 'deploy-worker', 'reconcile-schema', 'reconcile-access'])
	})

	test('sync-secrets only when pipeline.secrets is non-empty', async () => {
		const empty = await deploy(makeConfig({ pipeline: { secrets: [] } }), makeCtx(), makeRuntime(fresh()))
		expect(empty.plan.steps.map((s) => s.kind)).not.toContain('sync-secrets')

		const some = await deploy(makeConfig({ pipeline: { secrets: ['API_KEY'] } }), makeCtx({ secrets: { API_KEY: 'x' } }), makeRuntime(rec))
		expect(some.plan.steps.map((s) => s.kind)).toContain('sync-secrets')
	})

	test('full config keeps the canonical order', async () => {
		const config = makeConfig({
			schema: SCHEMA,
			access: ACCESS,
			pipeline: { build: 'bun run build', secrets: ['API_KEY'] },
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: { DB: new D1Database({ name: 'maindb', migrationsDir: './migrations' }) },
				}),
		})
		const ctx = makeCtx({ propustkaUrl: 'https://iam.example.com', secrets: { API_KEY: 'x' } })
		const result = await deploy(config, ctx, makeRuntime(rec))
		expect(result.plan.steps.map((s) => s.kind)).toEqual([
			'build',
			'provision-resources',
			'migrate',
			'deploy-worker',
			'reconcile-schema',
			'reconcile-access',
			'sync-secrets',
		])
		// dependsOn chains each step to the previous one.
		expect(result.plan.steps[0]?.dependsOn).toBeUndefined()
		expect(result.plan.steps[1]?.dependsOn).toEqual(['build'])
		expect(result.plan.steps[3]?.dependsOn).toEqual(['migrate:DB'])
	})
})

describe('step execution — collaborators + args', () => {
	test('build runs pipeline.build in the worker dir', async () => {
		await deploy(makeConfig({ pipeline: { build: 'bun run build', workerDir: 'worker' } }), makeCtx(), makeRuntime(rec))
		const build = rec.commands.find((c) => c.args.includes('bun run build'))
		expect(build).toBeDefined()
		expect(build?.command).toBe('sh')
		expect(build?.cwd).toBe('/work/worker')
	})

	test('provision calls oblaka with creds, env, remote (not dry-run) and worker dir', async () => {
		await deploy(makeConfig({ pipeline: { workerDir: 'worker' } }), makeCtx(), makeRuntime(rec))
		expect(rec.provisions).toHaveLength(1)
		const p = rec.provisions[0]
		expect(p?.accountId).toBe('acc-1')
		expect(p?.apiToken).toBe('tok-1')
		expect(p?.env).toBe('stage')
		expect(p?.dryRun).toBe(false)
		expect(p?.cwd).toBe('/work/worker')
	})

	test('provision uses a per-app state namespace (`<id>-state`) so apps in one account never collide', async () => {
		await deploy(makeConfig({ id: 'poplach' }), makeCtx(), makeRuntime(rec))
		expect(rec.provisions[0]?.stateNamespace).toBe('poplach-state')
	})

	test('ctx.stateNamespace overrides the derived default (for an app whose existing namespace differs)', async () => {
		await deploy(makeConfig({ id: 'poplach' }), makeCtx({ stateNamespace: 'legacy-ns' }), makeRuntime(rec))
		expect(rec.provisions[0]?.stateNamespace).toBe('legacy-ns')
	})

	test('migrate runs `wrangler d1 migrations apply <db> --remote` with cred env', async () => {
		const config = makeConfig({
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: { DB: new D1Database({ name: 'maindb', migrationsDir: './migrations' }) },
				}),
		})
		await deploy(config, makeCtx(), makeRuntime(rec))
		const migrate = rec.commands.find((c) => c.args[0] === 'd1')
		expect(migrate?.command).toBe('wrangler')
		expect(migrate?.args).toEqual(['d1', 'migrations', 'apply', 'maindb', '--remote'])
		expect(migrate?.env).toEqual({ CLOUDFLARE_API_TOKEN: 'tok-1', CLOUDFLARE_ACCOUNT_ID: 'acc-1' })
	})

	test('deploy-worker runs `wrangler deploy` with cred env in the worker dir', async () => {
		await deploy(makeConfig({ pipeline: { workerDir: 'worker' } }), makeCtx(), makeRuntime(rec))
		const dep = rec.commands.find((c) => c.command === 'wrangler' && c.args[0] === 'deploy')
		expect(dep).toBeDefined()
		expect(dep?.cwd).toBe('/work/worker')
		expect(dep?.env).toEqual({ CLOUDFLARE_API_TOKEN: 'tok-1', CLOUDFLARE_ACCOUNT_ID: 'acc-1' })
	})

	test('reconcile passes propustka url, app id, declarations and creds', async () => {
		const config = makeConfig({ schema: SCHEMA, access: ACCESS })
		const ctx = makeCtx({ propustkaUrl: 'https://iam.example.com', clientId: 'cid', clientSecret: 'csec' })
		await deploy(config, ctx, makeRuntime(rec))
		expect(rec.schemas).toEqual([{ url: 'https://iam.example.com', app: 'demo', schema: SCHEMA, clientId: 'cid', clientSecret: 'csec' }])
		expect(rec.accesses).toEqual([{ url: 'https://iam.example.com', app: 'demo', access: ACCESS, clientId: 'cid', clientSecret: 'csec' }])
	})

	test('sync-secrets pipes each ctx.secrets value into `wrangler secret put <name>`', async () => {
		const config = makeConfig({ pipeline: { secrets: ['API_KEY', 'DB_URL'] } })
		const ctx = makeCtx({ secrets: { API_KEY: 'k1', DB_URL: 'u1' } })
		await deploy(config, ctx, makeRuntime(rec))
		const puts = rec.commands.filter((c) => c.args[0] === 'secret')
		expect(puts).toHaveLength(2)
		expect(puts[0]?.args).toEqual(['secret', 'put', 'API_KEY'])
		expect(puts[0]?.stdin).toBe('k1')
		expect(puts[1]?.stdin).toBe('u1')
	})

	test('sync-secrets fails the step when a declared secret has no value', async () => {
		const config = makeConfig({ pipeline: { secrets: ['MISSING'] } })
		const result = await deploy(config, makeCtx({ secrets: {} }), makeRuntime(rec))
		expect(result.status).toBe('failed')
		const step = result.steps.find((s) => s.spec.kind === 'sync-secrets')
		expect(step?.status).toBe('failed')
		expect(step?.error).toContain('MISSING')
	})
})

describe('status transitions + fail-stop', () => {
	test('all steps succeed → status succeeded, every step succeeded with timing', async () => {
		const result = await deploy(makeConfig({ pipeline: { build: 'bun run build' } }), makeCtx(), makeRuntime(rec))
		expect(result.status).toBe('succeeded')
		for (const step of result.steps) {
			expect(step.status).toBe('succeeded')
			expect(typeof step.startedAt).toBe('number')
			expect(typeof step.finishedAt).toBe('number')
		}
	})

	test('a failing command fails its step, marks the rest skipped, and overall failed', async () => {
		const config = makeConfig({ schema: SCHEMA, pipeline: { build: 'bun run build' } })
		const ctx = makeCtx({ propustkaUrl: 'https://iam.example.com' })
		// Make the build command fail.
		const runtime = makeRuntime(rec, {
			commandResult: (
				spec,
			) => (spec.args.includes('bun run build') ? { exitCode: 1, stdout: '', stderr: 'build error' } : { exitCode: 0, stdout: '', stderr: '' }),
		})
		const result = await deploy(config, ctx, runtime)

		expect(result.status).toBe('failed')
		const byKind = Object.fromEntries(result.steps.map((s) => [s.spec.kind, s.status]))
		expect(byKind['build']).toBe('failed')
		expect(byKind['provision-resources']).toBe('skipped')
		expect(byKind['deploy-worker']).toBe('skipped')
		expect(byKind['reconcile-schema']).toBe('skipped')
		// No collaborator past the failure ran.
		expect(rec.provisions).toHaveLength(0)
		expect(rec.schemas).toHaveLength(0)
		const buildStep = result.steps.find((s) => s.spec.kind === 'build')
		expect(buildStep?.error).toContain('build error')
	})

	test('a throwing collaborator (oblaka) fails the step and stops the run', async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeRuntime(rec, { failProvision: true }))
		expect(result.status).toBe('failed')
		const provision = result.steps.find((s) => s.spec.kind === 'provision-resources')
		expect(provision?.status).toBe('failed')
		expect(provision?.error).toContain('oblaka boom')
		expect(result.steps.find((s) => s.spec.kind === 'deploy-worker')?.status).toBe('skipped')
	})
})

describe('dry-run', () => {
	test('runs oblaka in plan-only mode and skips every real mutation', async () => {
		const config = makeConfig({
			schema: SCHEMA,
			access: ACCESS,
			pipeline: { build: 'bun run build', secrets: ['API_KEY'] },
			resources: () =>
				new Worker({
					dir: '.',
					name: 'demo',
					compatibility_flags: ['nodejs_compat'],
					main: 'src/index.ts',
					bindings: { DB: new D1Database({ name: 'maindb', migrationsDir: './migrations' }) },
				}),
		})
		const ctx = makeCtx({ dryRun: true, propustkaUrl: 'https://iam.example.com', secrets: { API_KEY: 'x' } })
		const result = await deploy(config, ctx, makeRuntime(rec))

		expect(result.status).toBe('succeeded')
		// oblaka still runs — in dry-run mode.
		expect(rec.provisions).toHaveLength(1)
		expect(rec.provisions[0]?.dryRun).toBe(true)
		// No build / wrangler / secret commands and no real reconcile.
		expect(rec.commands).toHaveLength(0)
		expect(rec.schemas).toHaveLength(0)
		expect(rec.accesses).toHaveLength(0)
		// Each skipped mutation logged a `[dry-run]` line.
		const dryLines = rec.logs.filter((l) => l.includes('[dry-run]'))
		expect(dryLines.length).toBeGreaterThanOrEqual(5)
	})
})
