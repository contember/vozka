# @vozka/runner

This package has TWO faces:

1. **The CI deploy runner** — a container that clones a target repo, `bun install`s it, and runs `vozka
   deploy`. One container = one run. Plain-Bun code; no Cloudflare runtime.
2. **The vozka-runner WORKER** — the deploy EXECUTOR, split out of the control plane. It owns the
   per-run container DO + the relay, so a deploy of vozka never resets the container running that deploy
   (the self-reset that orphaned vozka's own runs). vozka calls it over a service binding
   (`RUNNER_SVC.startRun(job)`); it boots the container, relays logs → R2, and writes the terminal run
   status → D1. RPC-only — no public route; reachable ONLY via the binding.

Assumes the root CLAUDE.md.

## Commands (this package)

```bash
bun run serve            # run the in-container HTTP server locally (src/serve.ts)
bun test                 # protocol + server + runner + relay + finish-run unit tests
bun run docker:build     # docker build (context = repo ROOT); deps resolve from npm
bun run oblaka           # regenerate vozka-runner's wrangler.jsonc (plan/dry) from oblaka.ts
bun run bootstrap        # deploy vozka-runner itself, out-of-band (needs real CF creds; see the script header)
```

## Layout

In-container engine (face 1):

- `protocol.ts` — **the Worker↔container wire contract** (`RunnerJob`, `RunnerStatus`, `LogLine`, ports).
  The single source of truth shared with `@vozka/worker`; change both sides together.
- `server.ts` — the in-container HTTP server: `POST /run`, `GET /logs` (NDJSON stream), `/status`, `/health`.
- `runner.ts` / `spawn.ts` — the clone → install → `vozka deploy` pipeline.
- `Dockerfile` + `docker/` — the image (Ubuntu + git + node 22 + bun + wrangler + the baked `vozka` CLI).
- `image.json` — the PINNED runner image tag (bumped by `.github/workflows/runner-image.yml`); the config
  builds the registry ref from it. `RUNNER_BUILD=1` (or env=local) builds from the Dockerfile instead.

vozka-runner worker (face 2):

- `src/worker.ts` — the `VozkaRunner` `WorkerEntrypoint`: `startRun(job)` = boot container + relay → R2 +
  `finishRun` → D1. Re-exports the `RunnerContainer` DO. Default export. Imports `cloudflare:workers`.
- `src/RunnerContainer.ts` — the per-run container DO (`@cloudflare/containers`). Moved here from the worker.
- `src/relay.ts` — the Worker→container relay (logs → R2 + terminal status). Moved here from the worker.
- `src/finish-run.ts` — the ONE D1 write: a guarded terminal-status UPDATE (see invariants).
- `vozka-runner.config.ts` — the deploy surface (dogfoods vozka-config). `oblaka.ts` — the local-dev shim.
- `scripts/bootstrap-runner.ts` — out-of-band deploy of vozka-runner (it can't deploy itself through itself).

`src/index.ts` exports the LIGHT shared surface (protocol + relay helpers + the `VozkaRunner` TYPE) — NOT
the worker as a value, so importers don't pull the Workers runtime. `@vozka/worker` imports only that.

## Invariants

- **Secrets + credentials go to the `vozka` child via ENV only** — never on argv, never echoed in a
  response, never in a log line verbatim (the runner redacts them). They arrive in the `POST /run` body.
- **One run per process:** a second `POST /run` while one is active → 409.
- **`oblaka-iac` installs from npm** (pinned in `docker/package.json`, in lockstep with the workspace) — the
  published oblaka now ships the programmatic `deploy()`. The Docker build context is the repo ROOT.
- **`wrangler` must be on PATH globally** in the image — the deploy step shells out to a bare `wrangler` with cwd = the target repo.
- **vozka-runner is SEPARATE so a vozka deploy never resets it.** It's INFRA, not a registered app: no
  Access, no propustka schema, no runtime secrets (every credential arrives per-run in the `RunnerJob`).
  Deployed RARELY + OUT-OF-BAND (`bun run bootstrap`) — deploying it through itself would self-reset its
  own container. It changes only when the relay / container / image changes.
- **RUN_LOGS (R2) + DB (D1) are SHARED with the control plane** — oblaka ADOPTS them by remote name
  (`<env>-<name>`), so vozka-runner declares the same names + binds vozka's existing resources. It must
  use the SAME env as the control plane, and its `DB` declares NO `migrationsDir` — vozka owns the schema.
- **`finish-run.ts` DUPLICATES `@vozka/worker`'s `Db.markRunFinished`** (same guarded UPDATE) to avoid a
  back-import cycle (worker → runner for the protocol). The `WHERE status IN ('pending','running')` guard
  makes the double-write (control plane + vozka-runner) idempotent + order-independent. Keep the two identical.
- **`src/index.ts` never re-exports the worker / RunnerContainer as a VALUE** — only `export type
  { VozkaRunner }` — so a plain-Bun importer of `@vozka/runner` never loads `cloudflare:workers`.
