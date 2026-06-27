# `@vozka/cli init` — per-account base bring-up (design)

Status (2026-06-27): **Phase A built** + **Phase B landed except Stage 1 wiring**. propustka native-auth is
published (`@propustka/* 0.0.6`) WITH the seed-from-env primitive (`PROPUSTKA_PROVISIONING_KEY`); vozka is
co-versioned onto it — `reconcileAccess`/`AppAccess` dropped, `reconcileSchema({ adminKey })`, the worker
auth migrated to `PropustkaAuth`, the key collapsed to one `px_`, and `@vozka/cli` generates it. The ONE
remaining Phase B item is **wiring Stage 1 (propustka's own deploy) into `platform.yml`** — deferred to the
account bring-up (#24) because it needs propustka's OIDC + signing config provisioned into the Environment.
Supersedes the `scripts/bootstrap-*.ts` wizard (kept as legacy until the CLI is proven). Decided 2026-06-26.

## Goal

One published CLI brings up a whole CF account's vozka control-plane base — propustka + vozka-runner +
vozka — from (ideally) just a Cloudflare API token. No repo-local scripts, no local propustka checkout, no
hand-crafted base repo.

```
bunx @vozka/cli init mangoweb
```

### Locked decisions

- **Full base.** The generated `org/vozka-platform` pipeline runs **Stage 1 propustka** + **Stage 2
  vozka-runner + vozka**. "One command brings up the account."
- **Clean, wait for propustka.** No local-mint fallback. The bring-up uses the **seeded key** (below), which
  needs propustka's seed-from-env primitive (part of the operator's propustka refactor, NOT in the current
  PR) and a new-model propustka deployed to the account. mangoweb goes live AFTER those land — not before.
- **CLI, not a script.** New `packages/cli` (`@vozka/cli`), thin over `@vozka/core` (the engine). The
  `scripts/wizard/*` modules (manifest flow, cloudflare, envfile, prompt, shell, log) migrate into it.

## What `init <account>` does (idempotent, resumable)

1. **CF API token** (only hard input; `$CLOUDFLARE_API_TOKEN` or prompt) → resolve account id + name, list
   zones (→ domain suggestions).
2. **Collect the rest with smart defaults** (Enter-through): vozka domain (`vozka.<zone>`), GitHub org (from
   `gh auth`), bootstrap admin (from `gh` user), propustka URL (`propustka.<zone>`). Generated automatically:
   vault key, provisioning key (seeded — see below), GitHub App (manifest flow + browser SSO).
3. **Scaffold the base repo:** `gh repo create <org>/vozka-platform --private` if missing → materialize the
   pipeline from **templates checked into the CLI** (`platform.yml`, `vozka.ref`, `README.md`) → clone into
   `./vozka-platform/` → commit + push. Idempotent: re-run updates only on drift.
4. **GitHub Environment:** create the env (`<account>`/`prod`) and write secrets + vars **there** (not
   repo-level), so the pipeline reads them per-environment.
5. **`.env`** (gitignored) in the local dir = resume + operator record. The vault key is also printed ONCE,
   loud (unrecoverable).
6. **Trigger** the platform workflow (`build_runner_image=true` on first run → builds the runner image into
   this account's registry).

### Input minimization — honest scope

Truly derivable from the CF token: account id/name, zones. Auto: vault key, provisioning key, GitHub App.
Still a confirm-with-default (cannot come from the token): vozka domain, GitHub org, bootstrap admin,
propustka URL. So **CF token is the only _required_ input**, the rest is "Enter on the default" + one browser
SSO for the App. "Just the CF key" is ~80% — the App and the domain need a human/browser touch.

## Seeded key — replaces the local provision-key mint

The operator-generated provisioning credential is stored ONCE in the base repo's GitHub Environment and used
by BOTH stages — no minting, no propustka checkout, no branch-mismatch.

| Actor                   | Responsibility                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI**                 | generates the provisioning key (random), writes it to `.env` + the GitHub Environment secret                                                                                                                              |
| **propustka (Stage 1)** | reads it from env and **idempotently upserts** it as an admin/provisioning credential at deploy — the machine analog of `PROPUSTKA_BOOTSTRAP_ADMINS`. _(= the seed-from-env primitive to add in the propustka refactor.)_ |
| **vozka (Stage 2)**     | reads the **same** key and authenticates its `reconcileSchema`/`reconcileAccess` calls with it                                                                                                                            |

### Key SHAPE — RESOLVED (2026-06-27, against propustka `feat/propustka-native-auth`)

- **Single `px_` bearer.** A propustka credential is ONE opaque `px_<random>` token (SHA-256-hashed in the
  `credentials` table, plaintext returned once by `issueKey`). NOT an id/secret pair. So the provisioning key
  is one token in **one** env var (proposed `PROPUSTKA_PROVISIONING_KEY`), not `PROPUSTKA_CLIENT_ID`/`_SECRET`.
- **Reconcile auth = `adminKey` bearer.** `reconcileSchema({ url, app, schema, adminKey })` sends
  `Authorization: Bearer ${adminKey}` (the `px_`). vozka passes the single provisioning key as `adminKey`.
- **No `reconcileAccess` / no `AppAccess`.** CF Access is fully removed; the old `reconcileAccess` +
  `AppAccess`/`AccessAppDecl`/`AccessRule` are DELETED from `@propustka/*`. Per-path gating is now `AppGates`,
  **pure runtime SDK config consumed by `PropustkaAuth` in each app — NOT reconciled at deploy** and not a
  vozka concern. So vozka's whole "reconcile access" step + the `access` field on `defineApp` go away.
- **`IamClient.authenticate(request)` is gone** (caller resolution is now server-side `resolveCaller`); the
  app-side request-auth surface is `PropustkaAuth`. vozka's control-plane worker auth must migrate to it.

### The ONE missing primitive on the propustka side — seed-from-env

propustka has `IAM_BOOTSTRAP_ADMINS` (admit a human by email at resolution time) but **no machine analog**:
nothing reads a `px_` from env and admits it as a provisioning admin. Recommended (idiomatic, no DB writes):
in `worker/src/auth.ts resolveCaller`, alongside the local-dev bypass + the bootstrap-admin email check, add a
`PROPUSTKA_PROVISIONING_KEY` env — when a presented bearer's hash equals `hashToken(env)`, resolve a synthetic
global-admin caller (`permissions: [{ action: '*', scope: null, source: 'bootstrap' }]`), no `credentials`
row. Idempotent by construction (env compare), rotatable (change the env), no chicken-and-egg, no migration.

**Still required from propustka before vozka Phase B can land:** (1) the seed-from-env primitive above;
(2) bump `@propustka/core` + `@propustka/client` 0.0.5 → 0.0.6 and **publish** (the branch is unmerged,
unpublished — vozka on `^0.0.5` still resolves the OLD model).

## Build phases + dependencies

- **Phase A — propustka-agnostic CLI plumbing (buildable now).** `packages/cli` skeleton; `init` flow; CF
  token → account/zones; repo scaffold from templates; GitHub App (manifest flow, public-when-cross-org —
  already wired in `f58b910`); GitHub Environment + secrets/vars; `.env`; trigger. Treats the provisioning
  key as an opaque env value, so it needs nothing from propustka.
- **Phase B — seeded key + propustka Stage 1 + vozka co-version (after propustka publishes 0.0.6).** This is
  BIGGER than "finalize the key shape" — the native-auth refactor reshapes the whole reconcile + auth surface.
  All of it is coupled to the `@propustka/* ^0.0.5 → ^0.0.6` bump (it won't typecheck against 0.0.5), so it
  lands as one change:
  1. **Drop `reconcileAccess` entirely** (`core/deploy.ts`, `core/runtime.ts`): no successor — gates are
     runtime SDK config. Remove `ReconcileAccessError`, `AccessReconciler`, the access reconcile call.
  2. **`reconcileSchema` auth** `{ clientId, clientSecret }` → `{ adminKey }` (one `px_` bearer).
  3. **Config surface** (`vozka-config`): drop `AppAccess`/`AccessAppDecl`/`AccessRule` import + re-export and
     the `access` field on `defineApp`; per-app configs (poplach/revizor) drop their `access` block.
  4. **Worker auth seam** (`worker/iam.ts`): `IamClient.authenticate(request)` is gone → migrate to
     `PropustkaAuth`; rework `BootstrapAdminAuthContext`/the guard.
  5. **Key threading**: collapse `PROPUSTKA_CLIENT_ID` + `_SECRET` → one `PROPUSTKA_PROVISIONING_KEY` across
     `core/cli.ts`, `runner/protocol.ts`, `worker/run-lifecycle.ts`, `worker/env.ts`.
  6. **@vozka/cli**: generate one `px_` (not `{clientId, clientSecret}`); one Environment secret
     `PROPUSTKA_PROVISIONING_KEY`; update `init.ts` + `templates/platform.yml` + README.
  7. **Pin bump** `^0.0.5 → ^0.0.6` in every package.json + `docker/package.json`.
  8. **Wire Stage 1** propustka deploy into `platform.yml` (propustka already ships a `vozka.config.ts`).

## Out of scope / later

- Consolidating `@vozka/core`'s existing `vozka` deploy CLI into `@vozka/cli` (init + deploy under one bin).
- `contember/vozka-platform` via the same `init` (after mangoweb proves it).
- Disabling vozka self-deploy-through-runner once both base repos are proven (task #22).
