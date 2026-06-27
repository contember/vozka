# vozka

A deploy control plane for a Cloudflare Workers ecosystem. An app declares its full deploy surface
— CF resources (`oblaka-iac`), propustka authz (`schema`), and a build pipeline — in one
`vozka.config.ts`; vozka provisions + deploys it (CLI today; control-plane Worker + dashboard).

## Tech Stack

- **Bun** — runtime + workspaces. Libraries run TypeScript directly (`exports.bun` → `src`); no build step.
- **TypeScript** strict, ESM (`"type": "module"`) everywhere.
- **Cloudflare Workers** — Worker + Durable Objects + Containers + D1 + Queues + R2.
- `oblaka-iac` (CF provisioning DSL), `@propustka/*` (native auth + IAM, no Cloudflare Access), `@buzola/*` (SPA router).

## Commands

```bash
bun install                              # resolves the workspace (oblaka-iac from npm, pinned ^0.0.17)
bun run typecheck                        # all packages (bun run --filter '*' typecheck)
bun test                                 # all tests
bun test packages/core/src/__tests__/deploy.test.ts   # a single test file
bun run lint                             # biome lint .
bun run format                           # dprint fmt   (format:check to verify only)
```

Per-package dev/build commands live in each package's CLAUDE.md (core, worker, runner, dashboard).

## Project Structure

```
packages/config/      # vozka-config — the app-authoring surface (defineApp + re-exports). 3 files; covered here.
packages/core/        # @vozka/core — deploy engine + the `vozka` CLI.        → CLAUDE.md
packages/cli/         # @vozka/cli — operator bring-up CLI (`vozka init <account>`). → CLAUDE.md
packages/worker/      # @vozka/worker — the control-plane Worker.             → CLAUDE.md
packages/runner/      # @vozka/runner — the container deploy runner + the vozka-runner executor worker. → CLAUDE.md
packages/dashboard/   # @vozka/dashboard — buzola + React SPA.               → CLAUDE.md
```

`vozka-config` is the single import an app authors from — it bundles `defineApp` with every oblaka
resource primitive and the propustka declaration types, so a `vozka.config.ts` never imports
`oblaka-iac` or `@propustka/core` directly.

## Code Conventions

- **Format = dprint** (`dprint.json`): tabs, **no semicolons** (ASI), single quotes, line width 150. Run `bun run format` before committing.
- **Lint = biome** (`biome.json`, recommended ruleset with many rules relaxed). `noConsole` allows `info/warn/error/debug/log`.
- Generate caller-side IDs (UUIDv7), never in SQL. snake_case D1 row shapes mirror the migration files.

## Critical Invariants

- **`oblaka-iac` resolves from npm, pinned to `^0.0.17`** (the first published version with the programmatic
  `deploy()` the engine calls). The old `file:../oblaka` override is gone. vozka + oblaka + propustka are a
  co-versioned suite — bump the pin deliberately (every package + the runner image's `docker/package.json`).
  **`@propustka/* ^0.0.6`** is the native-auth model (propustka issues its own tokens, no Cloudflare Access):
  `reconcileSchema({ adminKey })` is the only reconcile, `PropustkaAuth` is the request-auth front door,
  the provisioning credential is one seeded `px_` key (`PROPUSTKA_PROVISIONING_KEY`). Bumping it again is a
  suite-wide co-version.
- **`config`, `core`, `worker`, `runner` relax exactly two strict flags** (`noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`) ONLY to tolerate oblaka's raw-TS source — `runner` joined the set
  when it began hosting `vozka-runner.config.ts` (the executor split), the same reason `worker` relaxes
  for its `vozka.config.ts`. Keep our own code strict; never widen the relaxation further or add `as` /
  `@ts-ignore` / `any` to work around oblaka — ask first.
- **NEVER log credentials or secret values.** They flow control-plane → `RunnerJob` → child env only; on
  error log a short message, never the error object that may carry a clone URL with an embedded token.
- **Self-deploy: `packages/worker/vozka.config.ts` is the single source of truth** for vozka's own
  resources; `oblaka.ts` is a thin shim over it. Never re-declare resources in `oblaka.ts`. Same shape for
  the EXECUTOR: `packages/runner/vozka-runner.config.ts` is the source of truth for vozka-runner (the
  separate worker that runs deploys, split out so a vozka deploy never resets the container running it);
  its `oblaka.ts` is a thin shim too. vozka deploys through the runner; vozka-runner deploys out-of-band.

## Module-Specific Context

- `packages/core/CLAUDE.md` — Read when: touching the deploy engine, the plan, the CLI, or the runtime seam.
- `packages/worker/CLAUDE.md` — Read when: touching the control plane — API/ACL, vault, secret resolution, run lifecycle, webhook, D1, or its infra config.
- `packages/runner/CLAUDE.md` — Read when: touching the container image, the in-container server, the Worker↔container protocol, or the vozka-runner executor worker (the deploy seam, the relay, the runner image manifest).
- `packages/dashboard/CLAUDE.md` — Read when: touching the SPA — routes, the API client, DTOs, or the buzola codegen.

Project background: `HANDOFF.md` (the deploy boundary + open decisions), `MIGRATION.md` (moving
contember + mangoweb off GitHub Actions onto vozka), and the design rationale at
`~/.claude/plans/quiet-strolling-stearns.md`.
