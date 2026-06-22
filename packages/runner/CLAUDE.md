# @vozka/runner

The CI deploy runner: a container that clones a target repo, `bun install`s it, and runs `vozka deploy`.
One container = one run. Assumes the root CLAUDE.md.

## Commands (this package)

```bash
bun run serve            # run the in-container HTTP server locally (src/serve.ts)
bun test                 # protocol + server + runner unit tests
bun run docker:build     # vendor the oblaka tarball, then docker build (context = repo ROOT)
```

## Layout

- `protocol.ts` — **the Worker↔container wire contract** (`RunnerJob`, `RunnerStatus`, `LogLine`, ports).
  The single source of truth shared with `@vozka/worker`; change both sides together.
- `server.ts` — the in-container HTTP server: `POST /run`, `GET /logs` (NDJSON stream), `/status`, `/health`.
- `runner.ts` / `spawn.ts` — the clone → install → `vozka deploy` pipeline.
- `Dockerfile` + `docker/` — the image (Ubuntu + git + node 22 + bun + wrangler + the baked `vozka` CLI).

## Invariants

- **Secrets + credentials go to the `vozka` child via ENV only** — never on argv, never echoed in a
  response, never in a log line verbatim (the runner redacts them). They arrive in the `POST /run` body.
- **One run per process:** a second `POST /run` while one is active → 409.
- **`oblaka-iac` is installed from a vendored tarball** (`docker/vendor/`), NOT npm — the published oblaka
  predates the programmatic `deploy()`. `docker:prepare` re-vendors it; the Docker build context is the repo root.
- **`wrangler` must be on PATH globally** in the image — the deploy step shells out to a bare `wrangler` with cwd = the target repo.
