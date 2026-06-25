import { beforeAll, describe, expect, test } from 'bun:test'
import { D1Database, Queue, R2Bucket, ServiceReference, type Worker } from 'vozka-config'
import type { buildVozkaWorker as BuildVozkaWorker } from '../../vozka.config'
import { ACTIONS, SCOPES, VOZKA_APP_ID } from '../actions'

// vozka's OWN deploy surface (packages/worker/vozka.config.ts) — DOGFOODING vozka-config. These
// tests prove: defineApp accepts vozka's config, the resource graph materializes with vozka's full
// binding set, the Access carve-out is PUBLIC for ONLY the webhook route, and the authz schema's
// actions/scopes match src/actions.ts exactly (no drift between declaration and enforcement).

// vozka.config materializes `access` at import from VOZKA_DOMAIN (falling back to a placeholder when
// unset — it must NOT throw, since the local-dev oblaka shim imports it without a domain). Set a real
// domain here so the destination assertions below are deterministic, then load the module.
type VozkaConfig = import('vozka-config').AppConfig
let config: VozkaConfig
let buildVozkaWorker: typeof BuildVozkaWorker

beforeAll(async () => {
	process.env['VOZKA_DOMAIN'] = 'vozka.test.example.com'
	const mod = await import('../../vozka.config')
	config = mod.default
	buildVozkaWorker = mod.buildVozkaWorker
})

/** Resolve a Worker binding by name (oblaka exposes the materialized graph on `worker.options`). */
function binding(worker: Worker, name: string): unknown {
	return worker.options.bindings?.[name]
}

describe('defineApp(vozka config)', () => {
	test('exports a valid AppConfig with id `vozka` and a resources builder', () => {
		expect(config.id).toBe(VOZKA_APP_ID)
		expect(config.id).toBe('vozka')
		expect(typeof config.resources).toBe('function')
	})

	test('the resource graph builds vozka full binding set (RUNNER_SVC/R2/D1/Queue + IAM off-local)', () => {
		const worker: Worker = config.resources({ env: 'stage', domain: 'vozka.test.example.com' })
		expect(worker.options.name).toBe('vozka')
		expect(worker.options.main).toBe('./src/index.ts')

		// The deploy executor is a SEPARATE worker (vozka-runner): vozka binds it as a SERVICE, not a
		// Container — so a deploy of vozka never resets the container running it. No Container here anymore.
		expect(binding(worker, 'RUNNER_SVC')).toBeInstanceOf(ServiceReference)
		expect(binding(worker, 'RUNNER')).toBeUndefined()
		expect(binding(worker, 'RUN_LOGS')).toBeInstanceOf(R2Bucket)
		expect(binding(worker, 'DB')).toBeInstanceOf(D1Database)
		expect(binding(worker, 'DEPLOY_QUEUE')).toBeInstanceOf(Queue)
		// Off-local stages bind the propustka IAM ServiceReference.
		expect(binding(worker, 'IAM')).toBeInstanceOf(ServiceReference)
	})

	test('DB declares migrations (drives a migrate step) and the assets SPA is the dashboard dist', () => {
		const worker = config.resources({ env: 'stage' })
		const db = binding(worker, 'DB')
		expect(db).toBeInstanceOf(D1Database)
		if (db instanceof D1Database) {
			expect(db.options.migrationsDir).toBe('./migrations')
			expect(db.options.name).toBe('vozka')
		}
		expect(worker.options.assets?.binding).toBe('ASSETS')
		expect(worker.options.assets?.directory).toBe('../dashboard/dist')
	})

	test('local omits the off-local service bindings (IAM + vozka-runner) and runs the FakeIamClient (DEV=true)', () => {
		const worker = buildVozkaWorker({ env: 'local' })
		expect(binding(worker, 'IAM')).toBeUndefined()
		expect(worker.options.vars?.['DEV']).toBe('true')
		// vozka-runner is an off-local service binding too — absent locally (no container deploys in dev).
		expect(binding(worker, 'RUNNER_SVC')).toBeUndefined()
	})

	test('domain from ctx flows into the VOZKA_DOMAIN var; off-local DEV is empty', () => {
		const worker = config.resources({ env: 'stage', domain: 'vozka.test.example.com' })
		expect(worker.options.vars?.['VOZKA_DOMAIN']).toBe('vozka.test.example.com')
		expect(worker.options.vars?.['DEV']).toBe('')
		expect(worker.options.vars?.['ENVIRONMENT']).toBe('stage')
	})
})

describe('Access carve-out (public ONLY for the GitHub webhook)', () => {
	test('exactly two CF apps: the gated operator host + the public webhook carve-out', () => {
		expect(config.access).toBeDefined()
		const apps = config.access?.apps ?? []
		expect(apps.length).toBe(2)
	})

	test('the operator host is gated (service-auth + human), NOT public', () => {
		const operator = config.access?.apps.find((a) => a.key === 'operator')
		expect(operator).toBeDefined()
		const kinds = operator?.rules.map((r) => r.kind) ?? []
		expect(kinds).toEqual(['service-auth', 'human'])
		expect(kinds).not.toContain('public')
		expect(operator?.destinations).toEqual(['vozka.test.example.com'])
	})

	test('the ONLY public app is the webhook, scoped to POST /webhooks/github exactly', () => {
		const publicApps = config.access?.apps.filter((a) => a.rules.some((r) => r.kind === 'public')) ?? []
		expect(publicApps.length).toBe(1)
		const webhook = publicApps[0]
		expect(webhook?.key).toBe('webhook')
		expect(webhook?.rules).toEqual([{ kind: 'public' }])
		// The bypass covers the webhook path and NOTHING else (not the bare host, not /api).
		expect(webhook?.destinations).toEqual(['vozka.test.example.com/webhooks/github'])
	})
})

describe('Schema actions/scopes match src/actions.ts (no drift)', () => {
	test('the schema action catalog is exactly the ACTIONS constants', () => {
		const declared = (config.schema?.actions ?? []).map((a) => a.action).sort()
		const fromActions = Object.values(ACTIONS).sort()
		expect(declared).toEqual(fromActions)
	})

	test('the scope dimensions are exactly the SCOPES constants', () => {
		const declared = (config.schema?.scopes ?? []).map((s) => s.type).sort()
		expect(declared).toEqual([SCOPES.APP, SCOPES.ENVIRONMENT].sort())
	})

	test('roles: operator → deploy.*, admin → *', () => {
		expect(config.schema?.roles['operator']?.permissions).toEqual(['deploy.*'])
		expect(config.schema?.roles['admin']?.permissions).toEqual(['*'])
	})

	test('every role permission is `*` or matches an action prefix in the catalog', () => {
		const actions = (config.schema?.actions ?? []).map((a) => a.action)
		for (const role of Object.values(config.schema?.roles ?? {})) {
			for (const permission of role.permissions) {
				if (permission === '*') {
					continue
				}
				if (permission.endsWith('.*')) {
					const prefix = permission.slice(0, -1) // keep the trailing dot, e.g. `deploy.`
					expect(actions.some((a) => a.startsWith(prefix))).toBe(true)
					continue
				}
				expect(actions).toContain(permission)
			}
		}
	})
})

describe('Pipeline', () => {
	test('workerDir is the worker package, build builds the dashboard, secrets are the runtime worker secrets', () => {
		expect(config.pipeline?.workerDir).toBe('.')
		expect(config.pipeline?.build).toContain('@vozka/dashboard')
		expect(config.pipeline?.secrets).toEqual([
			'VOZKA_VAULT_KEY',
			'GITHUB_APP_PRIVATE_KEY',
			'GITHUB_WEBHOOK_SECRET',
			'CLOUDFLARE_API_TOKEN',
			'PROPUSTKA_CLIENT_ID',
			'PROPUSTKA_CLIENT_SECRET',
		])
	})
})
