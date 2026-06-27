# @vozka/core

The deploy engine + the `vozka` CLI. Turns an `AppConfig` + `DeployContext` into an ordered plan and
executes it. Assumes the root CLAUDE.md.

## Layout

- `plan.ts` — **pure, side-effect-free**: derives WHICH steps apply and in WHAT order. Touches nothing external.
- `deploy.ts` — the orchestrator: runs the plan's steps in order, stops on first failure (rest → `skipped`).
- `runtime.ts` — the `DeployRuntime` seam: every side effect (shell, oblaka, propustka) behind an injectable interface.
- `types.ts` — `DeployContext` / `JobSpec` / `DeployPlan` / `DeployResult`.
- `cli.ts` — `vozka deploy --env=<env> [--config=<path>] [--dry-run]`; reads creds + secrets from env.

## Invariants

- **Step order is fixed and meaningful:** build → provision-resources → migrate → deploy-worker →
  reconcile-schema → sync-secrets. Steps that don't apply are ABSENT, not skipped. propustka is fully
  native (no Cloudflare Access), so there is NO `reconcile-access` step and no `AppAccess` — per-path
  gates are runtime SDK config in each app. A first `reconcile-schema` SELF-REGISTERS the app in
  propustka (`PUT /admin/apps/:app/schema`, no `ACCESS_APPS` gate, so no 404 "unknown app"); it
  authenticates with `ctx.adminKey` (the seeded `px_` provisioning bearer). Any reconcile error is fatal.
- **The orchestrator never spawns a process / calls oblaka / hits propustka directly** — only via
  `DeployRuntime`. That seam is what makes dry-run and unit tests possible. Add new side effects to the interface, not inline.
- **`dryRun` MUST skip every real mutation** (`wrangler deploy` / `d1 migrations apply` / `secret put`,
  the propustka reconciles) and log what it WOULD do; oblaka still runs in plan-only mode. Wire `dryRun` through any new step.
- **Shell args are an argv array, never a single shell string** (`CommandSpec.args`) — no shell, no injection.
  Exception: the user's `pipeline.build` runs via `sh -c` by design.
- **Creds are required even in dry-run** (oblaka needs them to materialize the resource graph).
- **oblaka state is per-app: `<app id>-state`** (overridable via `ctx.stateNamespace`). oblaka keys state by
  env WITHIN the namespace, so apps sharing one account MUST have distinct namespaces or they overwrite each
  other; the default matches the legacy `--state-namespace=<app>-state` pipelines, so a migrated app's first
  vozka deploy continues its existing state instead of re-provisioning.

## Tests

`bun test` — `src/__tests__/deploy.test.ts` drives the engine with a fake `DeployRuntime` (no Cloudflare).
