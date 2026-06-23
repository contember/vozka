// Plan derivation — pure, side-effect-free. Given a config + context it decides WHICH steps apply
// and in WHAT order, materializing a `DeployPlan` of `JobSpec`s. The orchestrator (`deploy.ts`)
// executes the plan; nothing here touches Cloudflare, propustka, or the shell.

import { D1Database, type Worker } from 'oblaka-iac'
import type { AppConfig } from 'vozka-config'
import type { DeployContext, DeployPlan, JobSpec } from './types'

/** One D1 database that carries migrations — what a `migrate` step applies. */
export interface MigratableDatabase {
	/** The binding name in the Worker (stable, env-independent). */
	binding: string
	/** The logical database name as declared in the resource graph. */
	name: string
}

/**
 * Find the D1 databases in a Worker's resource graph that declare a `migrationsDir` — those are the
 * ones a `migrate` step must `wrangler d1 migrations apply`. Databases without migrations are
 * provisioned by oblaka but need no apply step.
 */
export const findMigratableDatabases = (worker: Worker): MigratableDatabase[] => {
	const databases: MigratableDatabase[] = []
	for (const [binding, value] of Object.entries(worker.options.bindings ?? {})) {
		if (value instanceof D1Database && value.options.migrationsDir !== undefined) {
			databases.push({ binding, name: value.options.name })
		}
	}
	return databases
}

/**
 * Build the ordered deploy plan for one app + environment. Order is fixed and meaningful:
 * build → provision-resources → migrate → deploy-worker → reconcile-schema → reconcile-access →
 * sync-secrets. Steps that don't apply to this config are simply absent (not skipped).
 *
 * `worker` is the already-materialized resource graph (`config.resources({ env, domain })`); we take
 * it in so the caller evaluates it exactly once and we can inspect it for D1 migrations.
 */
export const buildPlan = (config: AppConfig, ctx: DeployContext, worker: Worker): DeployPlan => {
	const steps: JobSpec[] = []
	let previous: string | undefined

	const add = (spec: Omit<JobSpec, 'dependsOn'>): void => {
		steps.push(previous === undefined ? spec : { ...spec, dependsOn: [previous] })
		previous = spec.id
	}

	if (config.pipeline?.build !== undefined) {
		add({ id: 'build', kind: 'build', description: `Build the Worker (\`${config.pipeline.build}\`)` })
	}

	add({ id: 'provision-resources', kind: 'provision-resources', description: 'Provision Cloudflare resources via oblaka' })

	const databases = findMigratableDatabases(worker)
	for (const database of databases) {
		add({ id: `migrate:${database.binding}`, kind: 'migrate', description: `Apply D1 migrations for \`${database.binding}\` (${database.name})` })
	}

	add({ id: 'deploy-worker', kind: 'deploy-worker', description: 'Deploy the Worker (`wrangler deploy`)' })

	if (config.schema !== undefined && ctx.propustkaUrl !== undefined) {
		add({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Reconcile authz schema into propustka' })
	}

	if (config.access !== undefined && ctx.propustkaUrl !== undefined) {
		add({ id: 'reconcile-access', kind: 'reconcile-access', description: 'Reconcile Access edge rules into propustka' })
	}

	if (config.pipeline?.secrets !== undefined && config.pipeline.secrets.length > 0) {
		add({ id: 'sync-secrets', kind: 'sync-secrets', description: `Sync ${config.pipeline.secrets.length} secret(s) via \`wrangler secret put\`` })
	}

	return { appId: config.id, env: ctx.env, steps }
}
