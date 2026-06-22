// @vozka/core — the deploy engine + types that the CLI, control-plane worker, and runner all
// share. M0 ships the public contracts and a typed `deploy()` stub; the engine is M1.

export { deploy } from './deploy'
export type { AppConfig, DeployContext, DeployPlan, DeployResult, DeployStep, JobSpec, RunStatus, SecretRef, SecretScope } from './types'
