# vozka

A deploy control plane for a Cloudflare Workers ecosystem.

`vozka` lets each app declare its full deploy surface — Cloudflare resources (via
[`oblaka-iac`](https://github.com/contember/oblaka)), the
[propustka](https://github.com/contember/propustka) Access edge / authz schema, and a build
pipeline — from a single config file, then drives provisioning + deployment from one place
(CLI today, a control-plane Worker + dashboard later).

> **Status: M0 — skeleton + public contracts.** The packages compile and expose their public
> APIs, but the deploy engine, control-plane worker, dashboard UI, and CI runner are stubs to
> be filled in by later milestones (M1–M3). See each package below for what lands when.

## Packages

| Package              | Name               | What it is                                                                                                                                                                                          |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config`    | `vozka-config`     | The app-authoring surface. `defineApp()` plus re-exported `oblaka-iac` resource primitives and propustka `AppAccess`/`AppSchema` types, so an app authors its whole deploy surface from one import. |
| `packages/core`      | `@vozka/core`      | Deploy engine types + `deploy()` and the `vozka` CLI. M0 ships the contracts and CLI plumbing; the real engine is M1.                                                                               |
| `packages/worker`    | `@vozka/worker`    | The control-plane Worker (`WorkerEntrypoint`). Skeleton only; built in M3.                                                                                                                          |
| `packages/dashboard` | `@vozka/dashboard` | A [buzola](https://github.com/contember/buzola) + React SPA for the control plane. Skeleton only; built in M3.                                                                                      |
| `packages/runner`    | `@vozka/runner`    | The CI/container deploy runner. Placeholder only; Dockerfile + entrypoint arrive in M2.                                                                                                             |

## Authoring an app

```ts
import { defineApp, Worker } from 'vozka-config'

export default defineApp({
	id: 'my-app',
	resources: ({ env }) =>
		new Worker({
			dir: '.',
			name: 'my-app',
			main: './src/index.ts',
			compatibility_flags: ['nodejs_compat_v2'],
			compatibility_date: '2025-10-01',
			bindings: {},
		}),
	pipeline: {
		workerDir: '.',
		build: 'bun run build',
		secrets: ['API_TOKEN'],
	},
})
```

```sh
vozka deploy --env=production --config=./vozka.config.ts
```

## Development

```sh
bun install
bun run typecheck
```

Conventions (module type, TypeScript settings, scripts, biome/dprint) mirror the
[propustka](https://github.com/contember/propustka) monorepo.

## License

MIT
