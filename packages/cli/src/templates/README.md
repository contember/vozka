# vozka-platform ({{ACCOUNT}})

The **per-account root of trust** for the {{ACCOUNT}} Cloudflare account. Its GitHub pipeline deploys the
vozka control-plane **base** so vozka never deploys itself:

```
Stage 1 — propustka (root authz)        [DEFERRED — Phase B, see below]
Stage 2 — vozka-runner + vozka          ← deployed by `vozka platform deploy`
apps (poplach, revizor, …)              ← deployed THROUGH vozka, not here
```

Generated + maintained by **`vozka init {{ACCOUNT}}`** (`@vozka/cli`). Secrets + variables live in the
**`{{ACCOUNT}}` GitHub Environment** (Settings → Environments) and are written there by the CLI.

`contember/vozka` is public and pinned in [`vozka.ref`](./vozka.ref). The pipeline checks it out, then runs
its `vozka platform deploy` command, which deploys **vozka-runner first** (vozka binds `RUNNER_SVC` → it) then
**vozka**, both via the same engine that deploys every app — idempotent, so re-running is a safe redeploy.

## First bring-up

Run `vozka init {{ACCOUNT}}` from a laptop with the CF API token in hand — it creates this repo, the
GitHub App, the Environment + its secrets/vars, and triggers the workflow with `build_runner_image=true`
(the runner container image isn't in this account's registry yet — the first run builds + pushes it).

To close the escape hatch once propustka grants you admin: set the `{{ACCOUNT}}` Environment variable
`VOZKA_BOOTSTRAP_ADMINS` to `[]` and re-run the workflow.

## Routine redeploy / version bump

- Bump [`vozka.ref`](./vozka.ref) to a new `contember/vozka` commit/tag and push → redeploys the base.
- Or _Actions → platform → Run workflow_ manually (build_runner_image stays false).

## Stage 1 — propustka (Phase B)

propustka is the authz root vozka depends on, so it belongs in this repo's pipeline. It's **not wired yet** —
propustka's deploy is being refactored. Once it lands, Stage 1 deploys propustka here and **seeds** the
operator-generated provisioning key (`PROPUSTKA_CLIENT_ID`/`_SECRET`) that Stage 2 uses — no minting, no
local propustka checkout.
