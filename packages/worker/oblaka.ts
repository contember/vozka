// LOCAL-DEV / oblaka entry for vozka's infrastructure. THIN by design: the resource graph itself
// lives in `vozka.config.ts` (the single source of truth, dogfooding vozka-config), and this file
// just adapts it to oblaka's `define` so the local flows keep working unchanged:
//   - `bun run oblaka`        → regenerate wrangler.jsonc (plan/dry)
//   - `bun run oblaka:deploy` → remote provision (off-local, manual)
//   - `wrangler d1 migrations apply DB --local` → apply migrations against the local D1
//
// oblaka's `define` callback only gets `{ env }` (no domain) — vozka's domain is a deploy-time var on
// the `vozka deploy` path; locally there is no public domain, so `buildVozkaWorker` receives just env.
//
// The off-local `vozka deploy` self-deploy path does NOT go through this file — it loads
// `vozka.config.ts` directly (CLI / scripts/bootstrap.ts). Keep this shim and vozka.config.ts in
// lockstep by NEVER re-declaring resources here.

import { define } from 'oblaka-iac'
import { buildVozkaWorker } from './vozka.config'

export default define(({ env }) => buildVozkaWorker({ env }))
