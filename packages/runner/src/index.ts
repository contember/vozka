// @vozka/runner — the CI / container deploy runner. Two faces share this package:
//   1. The Worker↔container job protocol + the in-container server engine (the container ENTRYPOINT is
//      `serve.ts`). Plain-Bun code; no Cloudflare runtime.
//   2. The vozka-runner WORKER (`worker.ts` / `RunnerContainer.ts`) — the deploy executor split out of
//      the control plane. That code imports `cloudflare:workers` + `@cloudflare/containers`, so it is
//      NOT re-exported here as a value (it would pull the Workers runtime into every importer). The
//      vozka-runner deploy references it directly via its `main` entry; the control plane needs only
//      the LIGHT surface below (the relay helpers + the binding TYPE).

export type { LogLine, RunnerJob, RunnerState, RunnerStatus, SecretName } from './protocol'
export { isRunnerJob, RUNNER_HEALTH_PATH, RUNNER_PORT } from './protocol'
export { Runner } from './runner'
export type { RunnerEnv, Spawner, SpawnHandlers, SpawnResult, SpawnSpec } from './runner'
export { createServer } from './server'
export type { RunnerServer } from './server'
export { bunSpawner } from './spawn'

// The run relay + its keys — used by the control plane's run-lifecycle (the R2 log key) and by tests.
// Side-effect-light (imports only the protocol), safe to re-export as values.
export { finishRun } from './finish-run'
export type { D1Like } from './finish-run'
export { logsKey, relayRun, statusKey } from './relay'
export type { ContainerLike, R2Like, RelayOptions, RelayResult } from './relay'

// The vozka-runner Worker's RPC class — exported TYPE-ONLY so the control plane can type its
// `RUNNER_SVC` service binding (`Service<VozkaRunner>`) without loading the Workers-runtime module.
export type { VozkaRunner } from './worker'
