# Migrating contember + mangoweb onto vozka

How to move the existing GitHub-Actions deploys onto vozka. Two independent control planes — one per
Cloudflare account — never one vozka spanning accounts (vozka is single-account by design).

## Current state (today)

| Account       | propustka | Apps deployed via `.github/workflows/deploy.yml`                                            |
| ------------- | --------- | ------------------------------------------------------------------------------------------- |
| **contember** | live      | **opice** (`deploy/prod` only), **poplach** (`deploy/prod`)                                  |
| **mangoweb**  | live      | **poplach** (`deploy/mangoweb`), **revizor** (`deploy/mangoweb`, mangoweb-only — no opice)   |

revizor's `deploy.yml` carries a `deploy/prod → contember` target option, but it was never configured
(only the `mangoweb` GitHub Environment exists, `REVIZOR_HOSTNAME = revizor.mgwsite.com`) — so revizor is
**mangoweb-only** and was untouched by Phase 1–2. poplach is the only repo deployed to **both** accounts.

Each app's `deploy.yml` runs: `oblaka oblaka.ts --env --state-namespace=<app>-state --remote` →
`wrangler d1 migrations apply` → `bun run build` → `wrangler deploy` → propustka reconcile
(`provision:iam` / `provision:access`, gated on `vars.PROPUSTKA_URL`) → `wrangler secret put`.

**State namespaces:** poplach=`poplach-state`, opice=`opice-state` — both equal vozka's derived
`<app id>-state` (see core CLAUDE.md). So a migrated app's **first vozka deploy continues the existing
oblaka state** instead of re-provisioning. No override needed as long as `defineApp({ id })` matches the
legacy `<prefix>-state`.

## Target topology

Two self-contained single-account control planes:

```
contember CF account              mangoweb CF account
├─ vozka⟨contember⟩               ├─ vozka⟨mangoweb⟩
├─ propustka⟨contember⟩           ├─ propustka⟨mangoweb⟩
└─ opice, poplach                 └─ poplach, revizor
```

- A repo deployed to **both** orgs (poplach) is registered in **both** vozkas. Its single
  `vozka.config.ts` is account-agnostic (reads `env` / `domain` from context); each vozka injects its
  own CF account/token + propustka coords (build-time config, not the registry).
- **One GitHub App per vozka** (each has its own webhook URL + install). A repo for both orgs installs
  **both** Apps; a push fires both webhooks, and each vozka acts only on pushes whose ref matches one of
  its envs' `trigger_ref`. The existing branch convention routes cleanly:
  `deploy/prod` → contember only, `deploy/mangoweb` → mangoweb only (a vozka ignores non-matching refs —
  `getAppEnvByTriggerRef` returns nothing).
- **Env naming:** each account's env is `prod` (the account is the boundary — no `mangoweb` env). The
  mangoweb vozka maps its `prod` env to `trigger_ref = refs/heads/deploy/mangoweb`; contember's `prod` to
  `refs/heads/deploy/prod`. `stage` is dropped — migrated apps run `prod` only.

## Prerequisites

- ✅ oblaka `0.0.17` (programmatic `deploy()`), consumed from npm.
- ✅ per-app state namespace (`<app>-state`) wired in the engine.
- Per org, operator-held (the HANDOFF "deploy boundary" — none executed yet): CF account id +
  account-wide API token; a GitHub App (contents:read + webhooks) installed on the org's repos; a vault
  master key (`VOZKA_VAULT_KEY`); the public domains.

---

## Phase 1 — contember control plane (propustka already live)

1. Mint a vozka provisioning key from the **existing** contember propustka (`scripts/provision-key.ts`).
2. Run `packages/worker/scripts/bootstrap.ts` **locally** with the contember creds + `PROPUSTKA_*` +
   `VOZKA_VAULT_KEY` + `GITHUB_APP_*` + `VOZKA_BOOTSTRAP_ADMINS=["you@…"]` + `VOZKA_DOMAIN`. vozka deploys
   itself and reconciles its own Access/schema into contember propustka.
3. `scripts/seed.ts` → register the `vozka` + `propustka` apps.
4. Install the **contember GitHub App** on the vozka + propustka repos.
5. Verify self-deploy: push to the vozka repo → webhook → vozka redeploys itself. Then **close the escape
   hatch** (`VOZKA_BOOTSTRAP_ADMINS=[]`, redeploy) once propustka grants you admin.

## Phase 2 — migrate contember apps

Order: **opice first** (single-account, no mangoweb target → simplest), then **poplach** (contember
target only; leave its `deploy/mangoweb` target on the old pipeline until Phase 4). Use the per-app
recipe below.

## Phase 3 — mangoweb control plane (propustka already live)

1. Mint a vozka provisioning key from the **existing** mangoweb propustka.
2. `bootstrap.ts` **locally** against the **mangoweb** account → vozka⟨mangoweb⟩ (reconciles its own
   Access/schema into mangoweb propustka).
3. `seed.ts` + install the **mangoweb GitHub App** + verify self-deploy + close the escape hatch.

## Phase 4 — migrate the mangoweb targets (poplach + revizor)

Two apps deploy to mangoweb: **poplach** (also on contember — config already consolidated in Phase 2,
account-agnostic) and **revizor** (mangoweb-only). revizor's config consolidation is **DONE**
(`vozka.config.ts`, commit `c93eef4` on `contember/revizor` `main` — folds `oblaka.ts` +
`propustka.schema.ts` + `propustka.access.ts`, mirrors poplach; `id='revizor'` continues `revizor-state`),
so Phase 4 for revizor SKIPS the per-app consolidation recipe and starts at registration.

For **each** of poplach + revizor:

1. Register in vozka⟨mangoweb⟩: env `prod` (mangoweb account), `trigger_ref = refs/heads/deploy/mangoweb`,
   the mangoweb domain (`poplach.mgwsite.com` / `revizor.mgwsite.com`), and its mangoweb secrets into the
   vault — poplach: `CF_API_TOKEN` (the AE read token); revizor: NONE mandatory (`PSI_API_KEY` optional —
   add it to `vozka.config.ts` `pipeline.secrets` + the vault only if real PSI metrics are wanted).
2. Install the **mangoweb GitHub App** on the repo (now both Apps are installed where applicable).
3. Dry-run → deploy via vozka⟨mangoweb⟩ → verify against `<app>-state` in the **mangoweb** account
   (state continuity, NO re-provision; revizor's `revizor-state` = `<id>-state`, like poplach's).
4. Remove the `deploy/mangoweb` target from the `deploy.yml`. poplach's contember target went in Phase 2,
   so poplach's whole workflow can then be deleted; revizor is mangoweb-only, so removing its sole live
   target means revizor's entire `deploy.yml` (+ the now-orphaned `oblaka.ts`, `propustka.*.ts`,
   `scripts/provision-*.ts`) can be deleted once the vozka deploy is green.

---

## Per-app migration recipe (checklist)

1. **Consolidate config** — fold `oblaka.ts` + `propustka.schema.ts` + `propustka.access.ts` into one
   `vozka.config.ts` (`defineApp`); read `env` / `domain` from context, drop `<APP>_HOSTNAME` reads.
   Keep `defineApp({ id })` equal to the legacy `<prefix>-state` prefix (so state continues).
2. **Diff access/schema vs live propustka** — the reconcile is an idempotent PUT, so any drift between the
   consolidated config and what's live becomes a real change. The **first vozka reconcile must be a no-op**.
3. **Register in the org's vozka** — repo URL, env, domain, `trigger_ref`, GitHub installation id.
4. **Secrets into the vault** (per-app / per-env) — the third-party keys currently in GitHub Environments
   (`CF_AE_API_TOKEN`, `PSI_API_KEY`, `OPICE_SELF_READ_TOKEN`, …). The CF token + propustka key are
   vozka's platform config, NOT per-app secrets.
5. **Install the org's GitHub App** on the repo.
6. **Dry-run deploy** via vozka — confirm the plan and that provision targets `<app>-state`.
7. **Real deploy** via vozka (manual trigger). Verify: resources unchanged (state continuity, NO
   re-provision), worker live, migrations applied, access/schema reconciled with no diff, secrets set.
8. **Delete the migrated target** from `deploy.yml` — only after the vozka deploy is green.

## Risks & mitigations

- **State continuity** — derived `<id>-state` matches poplach/opice/revizor (verified — revizor's
  `deploy.yml` uses `--state-namespace=revizor-state` and `id='revizor'` ⇒ `revizor-state`). If any future
  app's legacy namespace ≠ `<id>-state`, plumb `DeployContext.stateNamespace` through the registry →
  `RunnerJob` → CLI (the engine supports the override; the worker/runner don't pass it through yet).
  _Contingency, not needed for poplach/opice/revizor._
- **Access/schema drift** — diff before cutover; the first reconcile-via-vozka should change nothing.
- **Secrets** — re-enter into each org's vault; never copy a token between orgs (each account, its own).
- **Webhook routing** — one GitHub App per vozka; env `trigger_ref` routes by branch; a vozka no-ops on
  refs it doesn't subscribe to.
- **Single-account** — two vozkas; never one vozka spanning both accounts.
- **Cutover concurrency** — vozka's per-app-env lock and the old workflow's `concurrency: group` are blind
  to each other. During cutover, deploy a given target through exactly ONE path at a time. Both paths are
  idempotent against the same `<app>-state`, so falling back to the old workflow mid-migration is safe.

## Decisions (settled)

1. **Env naming** — each account's env is `prod`; no `mangoweb` env name. The account is the boundary.
2. **propustka⟨mangoweb⟩** — already live → Phase 3 just mints a key (no bootstrap).
3. **`stage` env** — dropped; migrated apps run `prod` only.
4. **GitHub Apps** — two Apps, one per org (own webhook URL + install). Chosen over one-App webhook
   fan-out (simpler, fully independent control planes).
