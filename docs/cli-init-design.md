# `@vozka/cli init` — per-account base bring-up (design)

Status: **Phase A built** (`@vozka/cli`, `vozka init <account>`); **Phase B pending** the propustka refactor.
Supersedes the `scripts/bootstrap-*.ts` wizard (kept as legacy until the CLI is proven). Decided 2026-06-26
with the operator.

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

### ⚠️ Key SHAPE is the one open item — depends on the new propustka auth model

- **Old model:** `PROPUSTKA_CLIENT_ID` + `PROPUSTKA_CLIENT_SECRET` (Access service-token / client-credentials
  pair). vozka reads both today.
- **New model (refactor):** credentials are single `px_` bearer keys (`issueKey`/`mintFromKey`). Then the
  provisioning key is likely **one `px_` token**, not an id/secret pair — e.g. env `PROPUSTKA_PROVISIONING_KEY`.
  The CLI generates `px_<random>`; propustka Stage 1 upserts a credential whose hash = hash(token) under a
  stable identity (so re-deploy is a no-op / rotation); vozka presents the token as a bearer.
- **Co-version implication:** if provisioning auth collapses to a single key, vozka's `@propustka/client`
  reconcile auth changes from `(client_id, client_secret)` to one key — that's part of the
  `@propustka/* ^0.0.5 → ^0.0.6` bump (the co-versioned suite). Confirm the exact surface against the new
  `@propustka/client`.

**To finalize the seeded-key env contract + the vozka co-version change, I need:** the new propustka
provisioning auth shape (single `px_` key vs id/secret), the seed-from-env env name propustka will read, and
the `@propustka/client` reconcile auth signature in the new version.

## Build phases + dependencies

- **Phase A — propustka-agnostic CLI plumbing (buildable now).** `packages/cli` skeleton; `init` flow; CF
  token → account/zones; repo scaffold from templates; GitHub App (manifest flow, public-when-cross-org —
  already wired in `f58b910`); GitHub Environment + secrets/vars; `.env`; trigger. Treats the provisioning
  key as an opaque env value, so it needs nothing from propustka.
- **Phase B — seeded key + propustka Stage 1 + vozka co-version (after the propustka refactor lands).**
  Finalize the key shape; wire Stage 1 (propustka deploy + seed) into `platform.yml`; bump vozka's
  `@propustka/*` pin + adapt reconcile auth; drop any temporary escape.

## Out of scope / later

- Consolidating `@vozka/core`'s existing `vozka` deploy CLI into `@vozka/cli` (init + deploy under one bin).
- `contember/vozka-platform` via the same `init` (after mangoweb proves it).
- Disabling vozka self-deploy-through-runner once both base repos are proven (task #22).
