// @vozka/core — the deploy engine + types that the CLI, control-plane worker, and runner all
// share. M0 ships the public contracts and a typed `deploy()` stub; the engine is M1.

export { deploy } from './deploy'
export { buildPlan, findMigratableDatabases } from './plan'
export type { MigratableDatabase } from './plan'
export {
	type CommandResult,
	type CommandRunner,
	type CommandSpec,
	defaultRuntime,
	type DeployRuntime,
	type OblakaProvisioner,
	type ProvisionInput,
	type SchemaReconciler,
} from './runtime'
export type { AppConfig, DeployContext, DeployPlan, DeployResult, DeployStep, JobSpec, RunStatus, SecretRef, SecretScope } from './types'
