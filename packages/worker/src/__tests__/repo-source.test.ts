import { describe, expect, test } from 'bun:test'
import { decodePushEvent, normalizeRepoUrl, verifyWebhookSignature } from '../repo-source'
import { signWebhook } from './helpers/harness'

// Primitive-level unit tests for the RepoSource pure logic: HMAC-SHA256 webhook verification
// (good/bad/malformed), repo-URL normalization, and push decoding. The GitHub network calls
// (installation-token mint, App JWT sign) are CF/integration only and not unit-tested here.

describe('verifyWebhookSignature (HMAC-SHA256)', () => {
	const secret = 'top-secret'
	const body = '{"ref":"refs/heads/main"}'

	test('accepts a correct sha256= signature', async () => {
		const sig = await signWebhook(body, secret)
		expect(await verifyWebhookSignature(body, sig, secret)).toBe(true)
	})

	test('rejects a signature computed with the wrong secret', async () => {
		const sig = await signWebhook(body, 'wrong-secret')
		expect(await verifyWebhookSignature(body, sig, secret)).toBe(false)
	})

	test('rejects a tampered body (same signature, different body)', async () => {
		const sig = await signWebhook(body, secret)
		expect(await verifyWebhookSignature('{"ref":"refs/heads/evil"}', sig, secret)).toBe(false)
	})

	test('rejects a missing / malformed signature header', async () => {
		expect(await verifyWebhookSignature(body, null, secret)).toBe(false)
		expect(await verifyWebhookSignature(body, 'not-prefixed', secret)).toBe(false)
		expect(await verifyWebhookSignature(body, 'sha256=zzzz', secret)).toBe(false) // non-hex
		expect(await verifyWebhookSignature(body, 'sha256=abc', secret)).toBe(false) // odd length
	})
})

describe('normalizeRepoUrl', () => {
	test('reduces https / scp / .git / trailing-slash / host-case to one canonical form', () => {
		const canonical = 'github.com/acme/App'
		expect(normalizeRepoUrl('https://github.com/acme/App.git')).toBe(canonical)
		expect(normalizeRepoUrl('https://GitHub.com/acme/App/')).toBe(canonical)
		expect(normalizeRepoUrl('git@github.com:acme/App.git')).toBe(canonical)
		expect(normalizeRepoUrl('ssh://git@github.com/acme/App')).toBe(canonical)
		// Owner/repo case is preserved (only the host is lowercased).
		expect(normalizeRepoUrl('https://github.com/acme/App')).toBe(canonical)
	})
})

describe('decodePushEvent', () => {
	test('reads ref / clone_url / after / installation id', () => {
		const event = decodePushEvent(
			{ ref: 'refs/heads/deploy/prod', after: 'sha1', repository: { clone_url: 'https://github.com/a/b.git' }, installation: { id: 7 } },
			null,
		)
		expect(event).toEqual({ ref: 'refs/heads/deploy/prod', repoUrl: 'https://github.com/a/b.git', commitSha: 'sha1', installationId: 7 })
	})

	test('falls back to html_url and the header installation id', () => {
		const event = decodePushEvent({ ref: 'r', repository: { html_url: 'https://github.com/a/b' } }, 99)
		expect(event?.repoUrl).toBe('https://github.com/a/b')
		expect(event?.installationId).toBe(99)
		expect(event?.commitSha).toBeNull()
	})

	test('returns null when ref or repo is missing', () => {
		expect(decodePushEvent({ repository: { clone_url: 'x' } }, null)).toBeNull()
		expect(decodePushEvent({ ref: 'r' }, null)).toBeNull()
	})
})
