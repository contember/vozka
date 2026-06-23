// A realistic sample app config — used by `vozka deploy --env=stage --dry-run` to exercise the
// whole engine path locally (resource graph + plan + every step in plan-only mode) without touching
// real Cloudflare or propustka. NOT a published artifact; it lives under fixtures/ on purpose.

import { D1Database, defineApp, KVNamespace, Worker } from 'vozka-config'
import type { AppAccess, AppSchema } from 'vozka-config'

// The app's authz vocabulary — reconciled into propustka (only when PROPUSTKA_URL is set).
const schema: AppSchema = {
	scopes: [{ type: 'project', label: 'Project' }],
	actions: [
		{ action: 'note.read', description: 'Read notes' },
		{ action: 'note.write', description: 'Create / edit notes' },
	],
	roles: {
		viewer: { name: 'Viewer', permissions: ['note.read'] },
		editor: { name: 'Editor', permissions: ['note.read', 'note.write'] },
	},
}

// The app's Cloudflare Access edge rules — reconciled into propustka (only when PROPUSTKA_URL is set).
const access: AppAccess = {
	apps: [
		{
			key: 'web',
			name: 'sample-web',
			destinations: ['sample.example.com'],
			rules: [{ kind: 'service-auth' }, { kind: 'human', emailDomains: ['contember.com'] }],
		},
	],
}

export default defineApp({
	id: 'sample',
	resources: ({ env, domain }) =>
		new Worker({
			dir: 'worker',
			name: 'sample',
			compatibility_flags: ['nodejs_compat'],
			main: 'src/index.ts',
			vars: { ENVIRONMENT: env, PUBLIC_DOMAIN: domain ?? '' },
			bindings: {
				// A D1 with migrations → drives a `migrate` step.
				DB: new D1Database({ name: 'sample-db', migrationsDir: './migrations' }),
				// A KV namespace → provisioned by oblaka, no extra step.
				CACHE: new KVNamespace({ name: 'sample-cache' }),
			},
		}),
	schema,
	access,
	pipeline: {
		workerDir: 'worker',
		build: 'echo "build sample"',
		secrets: ['SAMPLE_API_KEY'],
	},
})
