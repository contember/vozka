# Vozka — build handoff (at the deploy boundary)

Vozka is a deploy control plane for the propustka ecosystem: a control-plane Worker that
spawns a Cloudflare Container which clones a target app repo and runs `vozka deploy` (the
`@vozka/core` engine) against the target's `vozka.config.ts`, into the right account with the
right secrets, reconciling propustka access — triggered by GitHub push or a manual button.

Design rationale: see `/home/matej21/.claude/plans/quiet-strolling-stearns.md`.

## What's built (M0–M5, all committed)

| Pkg / area              | What                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oblaka` (sibling repo) | New programmatic `deploy(definition, {accountId, apiToken, env, …})` API.                                                                                                                                                                                                                                                                                                                                                          |
| `@vozka/config`         | `defineApp({ id, resources, access?, schema?, pipeline? })`; re-exports oblaka primitives + propustka types.                                                                                                                                                                                                                                                                                                                       |
| `@vozka/core`           | Deploy engine: builds a plan (build → provision → migrate → deploy-worker → reconcile-schema/access → sync-secrets) and runs it via an injectable `DeployRuntime`. `vozka` CLI (`deploy --env [--config] [--dry-run]`).                                                                                                                                                                                                            |
| `@vozka/runner`         | Runner container: Dockerfile (Ubuntu + git + bun + wrangler + baked `vozka`); in-container job server (`POST /run` → clone → install → `vozka deploy`, NDJSON log stream, status/exit).                                                                                                                                                                                                                                            |
| `@vozka/worker`         | Control plane: D1 registry (apps/app_envs/app_secrets/runs), REST `/api` + GitHub webhook + manual trigger → Queue → consumer → `startRun` (RunnerContainer DO) → relay logs→R2 + status→D1; propustka ACL on every route; encrypted per-app secret vault (AES-256-GCM); single-account build-time deploy config (CF account/token + propustka coords injected into every job); `vozka.config.ts` (self) + bootstrap/seed scripts. |
| `@vozka/dashboard`      | buzola SPA: onboarding (paste repo + domain), apps/envs/secrets, runs with live log tail. Served via worker `ASSETS`.                                                                                                                                                                                                                                                                                                              |

**Verified locally:** `bun run typecheck` (all 5 packages) ✓ · `bun test` **136 pass / 0 fail** ✓ ·
biome lint (infos only) ✓ · dprint ✓ · runner Docker image builds & smoke-runs ✓ · D1 migrations
apply `--local` ✓ · offline dry-run builds the full 7-step plan (incl. vozka's own self-deploy) ✓.

## The deploy boundary — what needs YOU (real Cloudflare + secrets)

Nothing below was executed; all of it requires real accounts/credentials.

1. ~~**Publish oblaka** with the new programmatic `deploy()`.~~ **DONE** — published as
   `oblaka-iac@0.0.17`; the `file:../oblaka` override is dropped and every package + the runner image pins
   `oblaka-iac` from npm (`^0.0.17` / `>=0.0.17` peer). The `deploy()` work was reintegrated onto oblaka
   `main` (which had moved to 0.0.16 with OAuth-deploy changes) and released via its tag → CI pipeline.
2. **Cloudflare creds:** account id + API token for the **single account** vozka runs on and deploys
   into (propustka + vozka + the apps all share it). A second account gets its own propustka + vozka.
3. **Deploy propustka first** (its own `scripts/provision-access.ts` — sets up its Access front
   door), then **mint a vozka provisioning key** (propustka `POST /admin/api-keys`) →
   `PROPUSTKA_ACCESS_CLIENT_ID/SECRET`.
4. **GitHub App:** register one (repo contents read + webhooks); install on the app repos;
   capture the App private key + webhook secret.
5. **Worker secrets + vars for vozka** (all declared in `vozka.config.ts`, set by bootstrap):
   secrets `VOZKA_VAULT_KEY` (32 random bytes, base64 — the vault master key),
   `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `CLOUDFLARE_API_TOKEN` (the account-wide deploy
   token — vozka deploys every app with it), `PROPUSTKA_CLIENT_ID` / `PROPUSTKA_CLIENT_SECRET` (the
   propustka provisioning key); vars `CLOUDFLARE_ACCOUNT_ID` + `PROPUSTKA_URL`. These platform creds
   are injected into every deploy job (single-account — no per-account registry).
6. **Bootstrap (one-time):** run `packages/worker/scripts/bootstrap.ts` with the creds above in env and
   `VOZKA_BOOTSTRAP_ADMINS=["you@…"]` to deploy vozka itself. Then `scripts/seed.ts` to register the
   apps (vozka, propustka). Once propustka grants you admin, set `VOZKA_BOOTSTRAP_ADMINS=[]` and
   redeploy to close the escape hatch.
7. **Onboard the rest:** install the GitHub App + paste domain for poplach/revizor/opice.
8. **Migrate apps (incremental):** consolidate each app's `oblaka.ts` + `propustka.schema.ts` +
   `propustka.access.ts` into one `vozka.config.ts`; read `env`/`domain` from context. Until
   migrated, vozka dual-injects legacy `<APP>_HOSTNAME` so the old recipes keep working.

## Resolved since the original handoff

- **oblaka published + override dropped** — see boundary item 1 above (`oblaka-iac@0.0.17` from npm).
- **Per-app-env deploy lock** — closes the design's "coordinator DO" gap. A `DeployLock` Durable Object
  (one instance per `<app>:<env>`, `src/DeployLock.ts`) gives mutual exclusion: `executeDeploy` takes the
  lock before starting and releases it after; a contended run is left `pending` and re-enqueued (the
  consumer's `deferred` path), so two triggers for the same target can't race on cf-state / wrangler /
  propustka. The lease is TTL-bounded (self-heals if a consumer dies) and holder-checked.
- **Robustness fixes** — `isRunnerJob` now rejects blank CF creds; the `vozka` CLI exits 1 cleanly on a
  config-load/engine throw (no unhandled rejection); the runner's log replay buffer is capped (no OOM on a
  chatty build); the runner image pins `wrangler@4.72.0` to match the workspace.

## Known follow-ups / decisions for you

- **tsconfig strictness (needs a decision).** `@vozka/config` + `@vozka/core` relax
  `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature` because `oblaka-iac` ships
  **raw TS** (no `.d.ts`) and importing its types pulls its source through tsc (and it doesn't
  pass under the strict base). No per-line type hacks were used. **Principled fix:** have oblaka
  ship built `.d.ts` declarations — but that changes oblaka's packaging for every consumer
  (propustka/poplach/revizor/opice), so it wasn't done autonomously. Decide whether to invest.
- **oblaka dry-run isn't offline.** `deploy()` reads the `cf-state` KV via the CF API even with
  `dryRun:true`, so a real `vozka deploy --dry-run` needs real creds+network. Consider a fully
  offline plan-only mode in oblaka.
- **CF Containers long-job spike.** Containers sleep on inactivity / hard-kill ~15 min; a
  heartbeat keeps the runner alive, but verify a real multi-minute clone+build+deploy on CF.
- **Dashboard `/api/me` gap.** No identity/permissions endpoint, so nav can't pre-gate by ACL
  (forbidden states surface per-page). Small worker addition if wanted.
- **Marketplace (post-v1).** Public-repo onboarding (direct clone + poll/notify/1-click, pinned
  tags, scoped/short-lived creds for untrusted code) is designed-for but not built; the
  `RepoSource` seam is ready.

## Useful commands

```
bun install                     # resolves workspace (oblaka-iac from npm, pinned ^0.0.17)
bun run typecheck               # all packages
bun test                        # 143 tests
bun run --filter @vozka/dashboard build
cd packages/runner && bun run docker:build   # build runner image
cd packages/worker && bunx oblaka oblaka.ts && bunx wrangler d1 migrations apply DB --local
```
