import { resolve } from 'node:path'
import type { Worker } from 'oblaka-iac'
import type { AppConfig } from 'vozka-config'
import { buildPlan, findMigratableDatabases } from './plan'
import { defaultRuntime, type DeployRuntime } from './runtime'
import type { DeployContext, DeployResult, DeployStep, JobSpec, RunStatus } from './types'

/** Resolve the absolute directory the Worker source lives in (`pipeline.workerDir` over `cwd`). */
const workerDir = (config: AppConfig, ctx: DeployContext): string => resolve(ctx.cwd, config.pipeline?.workerDir ?? '.')

/** The cred env every real `wrangler` child needs — oblaka uses the SDK, wrangler reads these. */
const wranglerEnv = (ctx: DeployContext): Record<string, string> => ({
	CLOUDFLARE_API_TOKEN: ctx.apiToken,
	CLOUDFLARE_ACCOUNT_ID: ctx.accountId,
})

/** Throw a uniform error from a failed shell-out, folding stderr/stdout into the message. */
const commandError = (label: string, result: { exitCode: number; stdout: string; stderr: string }): Error => {
	const detail = (result.stderr.trim() || result.stdout.trim() || '(no output)').slice(0, 2000)
	return new Error(`${label} failed (exit ${result.exitCode}): ${detail}`)
}

/**
 * Everything one step's executor needs: the config, context, materialized worker graph, its dir,
 * the runtime, and whether this is a dry-run. Bundled so the per-kind handlers stay small.
 */
interface StepEnv {
	config: AppConfig
	ctx: DeployContext
	worker: Worker
	dir: string
	runtime: DeployRuntime
	dryRun: boolean
}

/** Run one step's effect. Resolves on success, throws on failure (caught + recorded by the loop). */
const runStep = async (spec: JobSpec, env: StepEnv): Promise<void> => {
	const { config, ctx, worker, dir, runtime, dryRun } = env

	switch (spec.kind) {
		case 'build': {
			const build = config.pipeline?.build
			if (build === undefined) {
				return
			}
			if (dryRun) {
				runtime.log(`  [dry-run] would run build: \`${build}\` in ${dir}`)
				return
			}
			const result = await runtime.runCommand({ command: 'sh', args: ['-c', build], cwd: dir })
			if (result.exitCode !== 0) {
				throw commandError(`build (\`${build}\`)`, result)
			}
			return
		}

		case 'provision-resources': {
			// Per-app state namespace (`<app id>-state` by default) so apps sharing one account don't
			// collide on oblaka's env-keyed state, and a migrated app continues its existing state.
			const stateNamespace = ctx.stateNamespace ?? `${config.id}-state`
			// oblaka always runs — in dry-run it provisions in plan-only mode (no remote, no writes),
			// which still materializes the resource graph + wrangler config so the path is exercised.
			const result = await runtime.provision({
				definition: worker,
				accountId: ctx.accountId,
				apiToken: ctx.apiToken,
				env: ctx.env,
				cwd: dir,
				stateNamespace,
				dryRun,
			})
			const names = result.wranglerConfigs.map((c) => c.config.name ?? '(unnamed)').join(', ')
			runtime.log(dryRun ? `  [dry-run] provisioned (plan-only): ${names}` : `  provisioned: ${names}`)
			return
		}

		case 'migrate': {
			// `migrate:<binding>` — apply by the D1 BINDING (env-stable), not the oblaka resource name (env-prefixed in wrangler.jsonc).
			const binding = spec.id.slice('migrate:'.length)
			const database = findMigratableDatabases(worker).find((d) => d.binding === binding)
			if (database === undefined) {
				throw new Error(`migrate: no migratable D1 database for binding \`${binding}\``)
			}
			if (dryRun) {
				runtime.log(`  [dry-run] would run: wrangler d1 migrations apply ${database.binding} --remote`)
				return
			}
			const result = await runtime.runCommand({
				command: 'wrangler',
				args: ['d1', 'migrations', 'apply', database.binding, '--remote'],
				cwd: dir,
				env: wranglerEnv(ctx),
			})
			if (result.exitCode !== 0) {
				throw commandError(`wrangler d1 migrations apply ${database.binding}`, result)
			}
			return
		}

		case 'deploy-worker': {
			if (dryRun) {
				runtime.log(`  [dry-run] would run: wrangler deploy in ${dir}`)
				return
			}
			const result = await runtime.runCommand({ command: 'wrangler', args: ['deploy'], cwd: dir, env: wranglerEnv(ctx) })
			if (result.exitCode !== 0) {
				throw commandError('wrangler deploy', result)
			}
			return
		}

		case 'reconcile-schema': {
			const schema = config.schema
			const propustkaUrl = ctx.propustkaUrl
			if (schema === undefined || propustkaUrl === undefined) {
				return
			}
			if (dryRun) {
				runtime.log(`  [dry-run] would reconcile schema for \`${config.id}\` against ${propustkaUrl}`)
				return
			}
			// propustka is fully native: `PUT /admin/apps/:app/schema` SELF-REGISTERS a new app (no
			// ACCESS_APPS gate, so no 404 "unknown app"). Any error is a real failure and propagates.
			await runtime.reconcileSchema({ url: propustkaUrl, app: config.id, schema, adminKey: ctx.adminKey })
			return
		}

		case 'sync-secrets': {
			const secrets = config.pipeline?.secrets ?? []
			for (const name of secrets) {
				const value = ctx.secrets[name]
				if (value === undefined) {
					throw new Error(`sync-secrets: missing value for secret \`${name}\` (not in ctx.secrets)`)
				}
				if (dryRun) {
					runtime.log(`  [dry-run] would run: wrangler secret put ${name} (value piped from ctx.secrets)`)
					continue
				}
				const result = await runtime.runCommand({
					command: 'wrangler',
					args: ['secret', 'put', name],
					cwd: dir,
					env: wranglerEnv(ctx),
					stdin: value,
				})
				if (result.exitCode !== 0) {
					throw commandError(`wrangler secret put ${name}`, result)
				}
			}
			return
		}
	}
}

/** Roll a list of plan specs into pending `DeployStep`s. */
const initSteps = (specs: JobSpec[]): DeployStep[] => specs.map((spec) => ({ spec, status: 'pending' as RunStatus }))

/**
 * Deploy one app to one environment: build the plan from `config` + `ctx`, execute its steps in
 * order (build, provision via oblaka, D1 migrations, `wrangler deploy`, propustka reconciles, secret
 * sync), and return the result. Stops on the first failure and marks the rest `skipped`.
 *
 * All side effects go through an injectable `DeployRuntime` (default: real Bun spawn + oblaka +
 * propustka) so this is fully unit-testable and so `ctx.dryRun` can short-circuit every real
 * Cloudflare/propustka mutation while still exercising the whole path.
 */
export const deploy = async (config: AppConfig, ctx: DeployContext, runtime: DeployRuntime = defaultRuntime): Promise<DeployResult> => {
	const dryRun = ctx.dryRun ?? false
	// Inject the app's NON-SECRET deploy vars (`ctx.vars`, the per-app-env registry config) into
	// `process.env` BEFORE materializing the resource graph, so the config reads them via
	// `process.env['NAME']` — the same way a migrated `oblaka.ts` does. The whole registry set is injected
	// (so optional vars work too); `pipeline.vars` then asserts each REQUIRED name resolved. Required even
	// in dry-run (the graph needs them to materialize, like creds); a declared var with no value is a hard
	// error — never ship a half-configured deploy. Only the NAME is ever logged, never a value.
	for (const [name, value] of Object.entries(ctx.vars ?? {})) {
		process.env[name] = value
	}
	for (const name of config.pipeline?.vars ?? []) {
		if (ctx.vars?.[name] === undefined) {
			throw new Error(`deploy: missing value for declared pipeline var \`${name}\` (not in ctx.vars)`)
		}
	}
	const worker = config.resources({ env: ctx.env, domain: ctx.domain })
	const dir = workerDir(config, ctx)
	const plan = buildPlan(config, ctx, worker)
	const steps = initSteps(plan.steps)
	const stepEnv: StepEnv = { config, ctx, worker, dir, runtime, dryRun }

	runtime.log(`Deploy ${plan.appId} → ${plan.env}${dryRun ? ' (dry-run)' : ''} — ${steps.length} step(s):`)
	for (const step of steps) {
		runtime.log(`  • ${step.spec.id} — ${step.spec.description}`)
	}

	let failed = false
	for (const step of steps) {
		if (failed) {
			step.status = 'skipped'
			continue
		}

		step.status = 'running'
		step.startedAt = Date.now()
		runtime.log(`→ ${step.spec.id}`)
		try {
			await runStep(step.spec, stepEnv)
			step.status = 'succeeded'
		} catch (error) {
			step.status = 'failed'
			step.error = error instanceof Error ? error.message : String(error)
			failed = true
			runtime.log(`✗ ${step.spec.id}: ${step.error}`)
		}
		step.finishedAt = Date.now()
	}

	return {
		appId: plan.appId,
		env: plan.env,
		status: failed ? 'failed' : 'succeeded',
		plan,
		steps,
	}
}
