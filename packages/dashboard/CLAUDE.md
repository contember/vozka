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
- **Auth is Cloudflare Access at the edge.** `src/lib/api.ts` `request()` hard-reloads on a 401 or an
  Access login bounce (opaque redirect / HTML-instead-of-JSON) so Access can re-challenge — a SPA fetch can't follow the cross-origin login.

## Patterns

- A route is `createPage().loader(...).route('/path').render(...)` (default export) under `src/routes/`.
- All API calls go through the typed `api` helper (`api.get/post/put/patch/del`) in `src/lib/api.ts` — same-origin, `credentials: 'include'`.
