# @vozka/worker

The control-plane Worker (`WorkerEntrypoint`): D1 registry + Queue + container runner + encrypted vault.
Drives a deploy from a GitHub push or a manual trigger. Assumes the root CLAUDE.md.

## Commands (this package)

```bash
bun run dev                                       # lopata dev on :18291 (DEV=true → FakeIamClient)
bunx wrangler d1 migrations apply DB --local      # apply migrations to the local D1
bun run oblaka                                     # regenerate wrangler.jsonc (plan/dry)
bun run bootstrap                                  # deploy vozka itself (needs real CF creds + env)
bun run seed                                       # register accounts + apps
```

`wrangler.jsonc` is auto-generated from `oblaka.ts` — DO NOT edit it by hand.

## Architecture

`fetch` routes: `/api/health` → ok · `POST /webhooks/github` → webhook · `/api/*` → ACL-gated control
surface · everything else → dashboard `ASSETS`. A trigger writes a `pending` run to D1 then enqueues;
`queue()` consumes (one run/message) → `executeDeploy` → `startRun` (RunnerContainer DO) → relay
logs→R2 + status→D1. Env/bindings shape: `src/env.ts`. Schema: `migrations/*.sql`.

## Invariants

- **ACL on every `/api/*` route.** Each handler calls `authorize(iam, request, ACTION, scope?)` before
  doing anything; actions/scopes live in `src/actions.ts`. The GitHub webhook (`src/webhook.ts`) is the
  ONLY unauthenticated route — HMAC-gated instead. Authn = Cloudflare Access; authz + audit = propustka.
- **Local vs off-local IAM by the `DEV` var:** `DEV='true'` → `FakeIamClient` (dev personas); `DEV=''` →
  real `IamClient` over the `IAM` binding. `VOZKA_BOOTSTRAP_ADMINS` is the first-operator escape hatch — fails CLOSED on a malformed value.
- **Vault (`src/vault.ts`): envelope AES-256-GCM**, KEK from `VOZKA_VAULT_KEY` (never in D1, never logged).
  Secret VALUES are write-only over the API; D1 stores only ciphertext + wrapped DEK. Losing the KEK is unrecoverable by design.
- **Secrets resolve by ref scheme** (`src/secret-resolver.ts`): `vault:` / `secretstore:` / `env:` / `literal:`.
  An unknown / unresolvable ref THROWS — never deploy with an empty credential.
- **Run lifecycle is status-guarded + idempotent** (`src/run-lifecycle.ts`): `markRunStarted` only moves
  pending→running, so a redelivered queue message is a no-op. ack handled runs; retry only on an unexpected throw.
- **Never log a secret/credential** (see root). The run row is written before the queue is touched (durable trigger).
- **`vozka.config.ts` is the source of truth** for vozka's own resources; keep `oblaka.ts` a thin shim (see root).

## Patterns

- All D1 access goes through `src/db.ts` (prepared statements, snake_case rows, caller-stamped UUIDv7).
- Errors via `src/http.ts` `error(status, msg)`; handlers return its Response. Unexpected throws → 500, never leak internals.
