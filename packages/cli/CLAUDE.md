# @vozka/cli

The operator-facing bring-up CLI. `bunx @vozka/cli init <account>` stands up a CF account's vozka
control-plane base. Assumes the root CLAUDE.md. The deploy ENGINE is `@vozka/core`; this package is only
the bring-up surface (it triggers CI, it does not deploy from the laptop).

## Layout

- `index.ts` — entry + arg parse (`init <account>`).
- `init.ts` — the orchestrator: CF token → account/zones → smart-default prompts → vault key → provisioning
  key → GitHub App → scaffold repo → GitHub Environment → trigger.
- `scaffold.ts` — create/refresh `<org>/vozka-platform` from `templates/` (`platform.yml`, `vozka.ref`,
  `README.md`, `gitignore`), commit + push. Idempotent.
- `environment.ts` — create the GitHub Environment + write its secrets/vars (`gh secret/variable set --env`).
- `github-app.ts` — the GitHub App manifest flow (PUBLIC when installed cross-org; see below).
- `cloudflare.ts` / `gh.ts` — CF API + `gh` CLI helpers. `prompt.ts` / `log.ts` / `shell.ts` / `envfile.ts`
  / `narrow.ts` — TTY, formatting, child-process, `.env` resume, runtime JSON narrowing.

## Invariants

- **NEVER print a secret VALUE.** `log.ts` has no helper that takes one. The single intentional exception is
  the vault KEK, printed ONCE (the operator must capture it — unrecoverable if lost). Secret values flow only
  into `.env`, `gh` over stdin, and the GitHub Environment.
- **Idempotent + resumable.** Every captured value persists to `.env` (Bun auto-loads it next run); a re-run
  reuses external resources (GitHub App, vault key) instead of orphaning them.
- **App visibility is DERIVED:** public iff any install repo is in a different org than the App's owner org
  (GitHub forbids a private App installing cross-org). Same-org stays private.
- **The provisioning key is a SEEDED key (Phase B):** the CLI generates it; propustka Stage 1 will SEED it,
  vozka Stage 2 USES it. No local-propustka mint. Until Phase B lands the account is intentionally not live.
- **`@vozka/core` owns the deploy.** This package never runs `wrangler`/oblaka/the engine — it triggers the
  scaffolded GitHub Actions pipeline, which calls `vozka platform deploy`.

See `docs/cli-init-design.md` for the full design + the Phase A/B split.
