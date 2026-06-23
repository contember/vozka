# vozka

A deploy control plane for a Cloudflare Workers ecosystem. An app declares its full deploy surface
— CF resources (`oblaka-iac`), propustka Access/authz, and a build pipeline — in one
`vozka.config.ts`; vozka provisions + deploys it (CLI today; control-plane Worker + dashboard).

## Tech Stack

- **Bun** — runtime + workspaces. Libraries run TypeScript directly (`exports.bun` → `src`); no build step.
- **TypeScript** strict, ESM (`"type": "module"`) everywhere.
- **Cloudflare Workers** — Worker + Durable Objects + Containers + D1 + Queues + R2.
- `oblaka-iac` (CF provisioning DSL), `@propustka/*` (Access edge + IAM), `@buzola/*` (SPA router).

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
packages/worker/      # @vozka/worker — the control-plane Worker.             → CLAUDE.md
packages/runner/      # @vozka/runner — the CI/container deploy runner.       → CLAUDE.md
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
- **`config`, `core`, `worker` relax exactly two strict flags** (`noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`) ONLY to tolerate oblaka's raw-TS source. Keep our own code strict;
  never widen the relaxation or add `as` / `@ts-ignore` / `any` to work around oblaka — ask first.
- **NEVER log credentials or secret values.** They flow control-plane → `RunnerJob` → child env only; on
  error log a short message, never the error object that may carry a clone URL with an embedded token.
- **Self-deploy: `packages/worker/vozka.config.ts` is the single source of truth** for vozka's own
  resources; `oblaka.ts` is a thin shim over it. Never re-declare resources in `oblaka.ts`.

## Module-Specific Context

- `packages/core/CLAUDE.md` — Read when: touching the deploy engine, the plan, the CLI, or the runtime seam.
- `packages/worker/CLAUDE.md` — Read when: touching the control plane — API/ACL, vault, secret resolution, run lifecycle, webhook, D1, or its infra config.
- `packages/runner/CLAUDE.md` — Read when: touching the container image, the in-container server, or the Worker↔container protocol.
- `packages/dashboard/CLAUDE.md` — Read when: touching the SPA — routes, the API client, DTOs, or the buzola codegen.

Project background: `HANDOFF.md` (the deploy boundary + open decisions), `MIGRATION.md` (moving
contember + mangoweb off GitHub Actions onto vozka), and the design rationale at
`~/.claude/plans/quiet-strolling-stearns.md`.
