import type { AppConfig } from '@vozka/config'
import type { DeployContext, DeployResult } from './types'

/**
 * Deploy one app to one environment: build the plan from `config` + `ctx`, execute its steps
 * (provision resources via oblaka, reconcile propustka access/schema, sync secrets, deploy the
 * Worker), and return the result.
 *
 * M0: contract only. The engine lands in M1 — until then this is a typed throw so callers and the
 * CLI can be wired and typechecked against the real signature.
 */
export const deploy = async (config: AppConfig, ctx: DeployContext): Promise<DeployResult> => {
	void config
	void ctx
	throw new Error('deploy: not implemented until M1')
}
