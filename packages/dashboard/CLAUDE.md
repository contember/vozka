# @vozka/dashboard

The control-plane SPA: buzola file-based router + React 19, served by the worker's `ASSETS` binding.
Assumes the root CLAUDE.md.

## Commands (this package)

```bash
bun run gen          # regenerate src/buzola.gen.ts from src/routes/ (Buzola codegen via Bun)
bun run dev          # vite on :18292, proxies /api → :18291 (run the worker's `bun run dev` alongside)
bun run typecheck    # gen + tsc --noEmit
bun run build        # gen + tsc + vite build → dist/ (what the worker serves)
```

## Invariants

- **`src/buzola.gen.ts` is GENERATED — never edit it.** Run `bun run gen` after adding/moving a route
  under `src/routes/`. `typecheck` and `build` run `gen` first.
- **DTO types in `src/lib/api.ts` are HAND-MIRRORED from `@vozka/worker`, not imported/generated.** The
  worker entry pulls in `cloudflare:workers` (un-bundleable in a browser) and returns `unknown`. When a
  worker `toXDto` mapper changes, update `src/lib/api.ts` by hand to match. `LogLine` likewise mirrors `@vozka/runner`'s protocol.
- **Auth is propustka-native (no Cloudflare Access edge).** On a 401 carrying a `loginUrl` (the worker's
  `error()` puts it there for a human-gated miss), `src/lib/api.ts` `request()` bounces the browser to
  propustka's SSO login (`redirect` rewritten to the current page) — a blind reload would just loop since
  there's no edge to re-challenge. A short `sessionStorage` bounce guard breaks the loop if we return still-unauthorized.

## Patterns

- A route is `createPage().loader(...).route('/path').render(...)` (default export) under `src/routes/`.
- All API calls go through the typed `api` helper (`api.get/post/put/patch/del`) in `src/lib/api.ts` — same-origin, `credentials: 'include'`.
