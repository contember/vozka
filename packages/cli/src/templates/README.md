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

## Stage 1 — propustka (deferred to the account bring-up)

propustka is the authz root vozka depends on, so it belongs in this repo's pipeline. It is native-auth now
and ships its own `vozka.config.ts`, so Stage 1 can deploy it here and **seed** the operator-generated
provisioning key — the `PROPUSTKA_PROVISIONING_KEY` secret propustka admits as a synthetic admin (no minting,
no local propustka checkout) and Stage 2 reconciles with. Wiring it needs propustka's own deploy config in
this Environment (signing keys, OIDC secret + issuer/client, human email domains). Until then propustka
deploys via its own repo pipeline; this Environment carries the shared `PROPUSTKA_PROVISIONING_KEY`.
