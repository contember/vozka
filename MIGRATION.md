# Migrating contember + mangoweb onto vozka

How to move the existing GitHub-Actions deploys onto vozka. Two independent control planes — one per
Cloudflare account — never one vozka spanning accounts (vozka is single-account by design).

## Current state (today)

| Account       | propustka | Apps deployed via `.github/workflows/deploy.yml`            |
| ------------- | --------- | ----------------------------------------------------------- |
| **contember** | live      | **opice** (`deploy/prod` only), **poplach** (`deploy/prod`) |
| **mangoweb**  | _verify_  | **poplach** (`deploy/mangoweb` → second CF account)         |

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
└─ opice, poplach                 └─ poplach
```

- A repo deployed to **both** orgs (poplach) is registered in **both** vozkas. Its single
  `vozka.config.ts` is account-agnostic (reads `env` / `domain` from context); each vozka injects its
  own CF account/token + propustka coords (build-time config, not the registry).
- **One GitHub App per vozka** (each has its own webhook URL + install). A repo for both orgs installs
  **both** Apps; a push fires both webhooks, and each vozka acts only on pushes whose ref matches one of
  its envs' `trigger_ref`. The existing branch convention routes cleanly:
  `deploy/prod` → contember only, `deploy/mangoweb` → mangoweb only (a vozka ignores non-matching refs —
  `getAppEnvByTriggerRef` returns nothing).
- **Env naming:** call each account's env `prod` (the account is the boundary). The mangoweb vozka maps
  its `prod` env to `trigger_ref = refs/heads/deploy/mangoweb`. (Decision below.)

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

## Phase 3 — mangoweb control plane

1. **propustka⟨mangoweb⟩:** if it doesn't exist yet, deploy it + bootstrap its Access front door (its own
   `scripts/provision-access.ts`) on the mangoweb account; then mint a vozka key. If it already exists,
   just mint the key. _(Open item — verify.)_
2. `bootstrap.ts` **locally** against the **mangoweb** account → vozka⟨mangoweb⟩.
3. `seed.ts` + install the **mangoweb GitHub App** + verify self-deploy + close the escape hatch.

## Phase 4 — migrate the mangoweb target (poplach)

1. Register **poplach** in vozka⟨mangoweb⟩: env `prod` (mangoweb account), `trigger_ref =
   refs/heads/deploy/mangoweb`, the mangoweb domain, and poplach's mangoweb secrets into the vault.
2. Install the **mangoweb GitHub App** on poplach (now both Apps are installed).
3. Dry-run → deploy via vozka⟨mangoweb⟩ → verify against `poplach-state` in the **mangoweb** account.
4. Remove the `deploy/mangoweb` target from poplach's `deploy.yml`. Its contember target went in Phase 2,
   so the whole workflow can now be deleted.

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

- **State continuity** — derived `<id>-state` matches poplach/opice (verified). If any future app's legacy
  namespace ≠ `<id>-state`, plumb `DeployContext.stateNamespace` through the registry → `RunnerJob` → CLI
  (the engine supports the override; the worker/runner don't pass it through yet). _Contingency, not needed
  for poplach/opice._
- **Access/schema drift** — diff before cutover; the first reconcile-via-vozka should change nothing.
- **Secrets** — re-enter into each org's vault; never copy a token between orgs (each account, its own).
- **Webhook routing** — one GitHub App per vozka; env `trigger_ref` routes by branch; a vozka no-ops on
  refs it doesn't subscribe to.
- **Single-account** — two vozkas; never one vozka spanning both accounts.
- **Cutover concurrency** — vozka's per-app-env lock and the old workflow's `concurrency: group` are blind
  to each other. During cutover, deploy a given target through exactly ONE path at a time. Both paths are
  idempotent against the same `<app>-state`, so falling back to the old workflow mid-migration is safe.

## Open decisions

1. **Env naming** — call the mangoweb account's env `prod` (recommended; account is the boundary) vs keep
   `mangoweb` as an env name.
2. **propustka⟨mangoweb⟩** — does it already exist (→ just mint a key) or need bootstrapping (Phase 3.1)?
3. **`stage` env** — today a `workflow_dispatch` `stage` exists. Carry it into vozka as another env, or
   drop it for the migrated apps?
4. **GitHub Apps** — confirm two Apps (one per org). Alternative (one App, webhook fan-out) is more
   complex and not recommended.
