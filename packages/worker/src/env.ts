/**
 * The control-plane Worker's CF bindings + vars/secrets. Single source of truth for the
 * worker's environment shape. M2 adds the container + run-log bindings the runner relay needs;
 * the full control plane (D1 run schema / queues / scheduling) is M3.
 */
import type { RunnerContainer } from './RunnerContainer'

export interface Env {
	/** Control-plane SPA static assets, served for non-`/api/*` paths. */
	ASSETS: Fetcher
	/** Per-run deploy-runner container, backed by a Durable Object. */
	RUNNER: DurableObjectNamespace<RunnerContainer>
	/** R2 bucket the relay writes run logs + terminal status into, keyed by run id. */
	RUN_LOGS: R2Bucket
}
