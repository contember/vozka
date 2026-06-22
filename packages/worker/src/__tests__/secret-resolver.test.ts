import { describe, expect, test } from 'bun:test'
import { EnvSecretResolver, type SecretStoreEntry, VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { createHarness } from './helpers/harness'

// The ref-scheme dispatch: a ref's `<backend>:` prefix selects WHICH backend resolves it. These cover
// every scheme — vault / secretstore / env / literal — plus the fail-loud behaviour for missing
// backends and unknown schemes. The resolver handles per-app secret refs (`resolveSecret`).

function testKey(): string {
	const raw = new Uint8Array(32).fill(7)
	let binary = ''
	for (const b of raw) binary += String.fromCharCode(b)
	return btoa(binary)
}

/** A fake CF Secrets Store entry (the real binding's `get()` is the same shape). */
class FakeStoreEntry implements SecretStoreEntry {
	constructor(private readonly value: string) {}
	get(): Promise<string> {
		return Promise.resolve(this.value)
	}
}

describe('VaultSecretResolver dispatch', () => {
	test('vault:<id> → the encrypted D1 vault', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret('app', 'l', 'from-vault')
		const resolver = new VaultSecretResolver({ vault })
		expect(await resolver.resolveSecret(ref)).toBe('from-vault')
	})

	test('secretstore:<name> → the CF Secrets Store entry', async () => {
		const resolver = new VaultSecretResolver({ secretStore: { ACME_CF_TOKEN: new FakeStoreEntry('store-token') } })
		expect(await resolver.resolveSecret('secretstore:ACME_CF_TOKEN')).toBe('store-token')
	})

	test('secretstore: with no binding present fails loudly (CF-only path)', async () => {
		const resolver = new VaultSecretResolver({ secretStore: {} })
		await expect(resolver.resolveSecret('secretstore:MISSING')).rejects.toThrow(/CF-only/)
		// Also when the whole secretStore map is absent.
		const noStore = new VaultSecretResolver({})
		await expect(noStore.resolveSecret('secretstore:X')).rejects.toThrow()
	})

	test('env:NAME → the provided env source; missing var throws (no value leak)', async () => {
		const resolver = new VaultSecretResolver({ env: { TOKEN: 'env-value' } })
		expect(await resolver.resolveSecret('env:TOKEN')).toBe('env-value')
		await expect(resolver.resolveSecret('env:NOPE')).rejects.toThrow(/env var not present/)
	})

	test('literal:VALUE → the value verbatim', async () => {
		const resolver = new VaultSecretResolver({})
		expect(await resolver.resolveSecret('literal:plain')).toBe('plain')
		expect(await resolver.resolveSecret('literal:')).toBe('') // empty literal is valid
	})

	test('a vault ref with no vault configured fails loudly', async () => {
		const resolver = new VaultSecretResolver({ env: {} })
		await expect(resolver.resolveSecret('vault:abc')).rejects.toThrow(/vault backend not configured/)
	})

	test('unknown scheme + a ref with no colon both throw', async () => {
		const resolver = new VaultSecretResolver({})
		await expect(resolver.resolveSecret('wat:foo')).rejects.toThrow(/unsupported/)
		await expect(resolver.resolveSecret('nocolon')).rejects.toThrow(/<backend>/)
	})
})

describe('EnvSecretResolver (dev/test backward-compat)', () => {
	test('still resolves env: and literal:', async () => {
		const resolver = new EnvSecretResolver({ T: 'tok' })
		expect(await resolver.resolveSecret('env:T')).toBe('tok')
		expect(await resolver.resolveSecret('literal:v')).toBe('v')
		await expect(resolver.resolveSecret('env:MISSING')).rejects.toThrow()
	})
})
