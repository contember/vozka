import { FakeIamClient, type FakePersona } from '@propustka/client'
import { describe, expect, test } from 'bun:test'
import { ACTIONS } from '../actions'
import { authorize, createIam, parseBootstrapAdmins, withBootstrapAdmins } from '../iam'

// The VOZKA_BOOTSTRAP_ADMINS fallback (src/iam.ts): a caller whose VERIFIED email is in the list is
// authorized as admin even when the underlying IAM client would DENY — the escape hatch for the first
// operator before propustka grants them anything. Mirrors propustka's IAM_BOOTSTRAP_ADMINS: matched
// on the edge-verified email, granting the built-in `admin` role; a non-listed caller is unaffected.

// A request carrying the persona selector (the email) in the dev header the FakeIamClient reads.
function reqAs(email: string): Request {
	return new Request('https://vozka.example/api/accounts', { method: 'POST', headers: { 'X-Dev-Principal': email } })
}

// A FakeIamClient in PERSONA mode where every listed persona holds ONLY deploy.read globally — so the
// underlying client DENIES account.manage. Any authorization that succeeds for account.manage can only
// come from the bootstrap-admin override.
function lowPrivClient(emails: string[]): FakeIamClient {
	const personas: Record<string, FakePersona> = {}
	for (const email of emails) {
		personas[email] = { id: `p-${email}`, label: email, type: 'user', permissions: [{ action: 'deploy.read', scope: null, source: 'grant' }] }
	}
	return new FakeIamClient({ personas, defaultPersona: emails[0] })
}

describe('parseBootstrapAdmins', () => {
	test('parses a JSON array of emails', () => {
		expect([...parseBootstrapAdmins('["a@x.test","b@x.test"]')]).toEqual(['a@x.test', 'b@x.test'])
	})

	test('empty / unset / malformed all fail closed to an empty set', () => {
		expect(parseBootstrapAdmins(undefined).size).toBe(0)
		expect(parseBootstrapAdmins('').size).toBe(0)
		expect(parseBootstrapAdmins('[]').size).toBe(0)
		expect(parseBootstrapAdmins('not json').size).toBe(0)
		expect(parseBootstrapAdmins('{"a":1}').size).toBe(0) // non-array → empty
		expect([...parseBootstrapAdmins('["ok@x.test", 42, null]')]).toEqual(['ok@x.test']) // non-strings dropped
	})
})

describe('withBootstrapAdmins fallback', () => {
	test('a listed admin email is authorized for an action the underlying client denies', async () => {
		const iam = withBootstrapAdmins(lowPrivClient(['boss@vozka.test', 'nobody@vozka.test']), new Set(['boss@vozka.test']))
		const result = await authorize(iam, reqAs('boss@vozka.test'), ACTIONS.ACCOUNT_MANAGE)
		expect(result.ok).toBe(true)
	})

	test('a bootstrap admin can do EVERY action (built-in admin = *)', async () => {
		const iam = withBootstrapAdmins(lowPrivClient(['boss@vozka.test']), new Set(['boss@vozka.test']))
		for (const action of Object.values(ACTIONS)) {
			const result = await authorize(iam, reqAs('boss@vozka.test'), action)
			expect(result.ok).toBe(true)
		}
	})

	test('a NON-listed email still gets the underlying decision (denied account.manage → 403)', async () => {
		const iam = withBootstrapAdmins(lowPrivClient(['boss@vozka.test', 'nobody@vozka.test']), new Set(['boss@vozka.test']))
		const result = await authorize(iam, reqAs('nobody@vozka.test'), ACTIONS.ACCOUNT_MANAGE)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.response.status).toBe(403)
		}
	})

	test('a non-listed email keeps the actions it DOES hold (deploy.read still allowed)', async () => {
		const iam = withBootstrapAdmins(lowPrivClient(['nobody@vozka.test']), new Set(['boss@vozka.test']))
		const result = await authorize(iam, reqAs('nobody@vozka.test'), ACTIONS.DEPLOY_READ)
		expect(result.ok).toBe(true)
	})

	test('an unauthenticated caller is NOT rescued — the underlying failure passes through (403)', async () => {
		// Unknown persona (no default) → the fake returns unknown_principal (403); the bootstrap list
		// can't rescue it because there is no verified email to match.
		const base = new FakeIamClient({ personas: {}, defaultPersona: 'ghost@vozka.test' })
		const iam = withBootstrapAdmins(base, new Set(['ghost@vozka.test']))
		const result = await authorize(iam, reqAs('ghost@vozka.test'), ACTIONS.ACCOUNT_MANAGE)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.response.status).toBe(403)
		}
	})

	test('a SERVICE principal is never a bootstrap admin (no email to match)', async () => {
		// A persona of type 'service' whose label happens to collide with a listed email must NOT be
		// rescued — only USER principals carry a verified email.
		const iam = withBootstrapAdmins(
			new FakeIamClient({
				personas: {
					'svc@vozka.test': {
						id: 'p-svc',
						label: 'svc@vozka.test',
						type: 'service',
						permissions: [{ action: 'deploy.read', scope: null, source: 'grant' }],
					},
				},
				defaultPersona: 'svc@vozka.test',
			}),
			new Set(['svc@vozka.test']),
		)
		const result = await authorize(iam, reqAs('svc@vozka.test'), ACTIONS.ACCOUNT_MANAGE)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.response.status).toBe(403)
		}
	})

	test('an EMPTY bootstrap list is a transparent pass-through (returns the client unchanged)', () => {
		const base = lowPrivClient(['x@vozka.test'])
		expect(withBootstrapAdmins(base, new Set())).toBe(base)
	})
})

describe('createIam wires the fallback from VOZKA_BOOTSTRAP_ADMINS', () => {
	test('local (DEV) with a bootstrap admin: the default persona (admin@vozka.test) is the dev admin anyway', async () => {
		// In DEV the default persona is admin@vozka.test (already `*`). Use a viewer persona to prove the
		// bootstrap override kicks in: viewer@vozka.test holds only deploy.read, but listing it as a
		// bootstrap admin lets it manage accounts.
		const iam = createIam({ DEV: 'true', VOZKA_BOOTSTRAP_ADMINS: '["viewer@vozka.test"]' })
		const result = await authorize(iam, reqAs('viewer@vozka.test'), ACTIONS.ACCOUNT_MANAGE)
		expect(result.ok).toBe(true)
	})

	test('local (DEV) with no bootstrap admins: a viewer persona is still denied account.manage', async () => {
		const iam = createIam({ DEV: 'true', VOZKA_BOOTSTRAP_ADMINS: '[]' })
		const result = await authorize(iam, reqAs('viewer@vozka.test'), ACTIONS.ACCOUNT_MANAGE)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.response.status).toBe(403)
		}
	})
})
