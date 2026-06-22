// The APP-SECRET resolution seam.
//
// The registry stores `app_secrets.value_ref` as a REFERENCE, never plaintext. At deploy time those
// refs must become actual values to put in the `RunnerJob` (the app's `pipeline.secrets` values the
// runner `wrangler secret put`s). A ref encodes WHICH BACKEND holds the value (its scheme prefix), and
// the resolver dispatches on it — so the same interface serves both the encrypted D1 vault and CF
// Secrets Store, with env/literal kept for dev/local. Everything downstream (queue consumer, job
// assembly) depends ONLY on the `SecretResolver` interface, so swapping backends never touches a
// caller. Resolved values are NEVER logged and live only on the in-flight `RunnerJob`.
//
// Platform credentials (the CF API token, propustka provisioning creds) are NOT resolved here — vozka
// is single-account, so they are vozka's own Worker secrets (src/env.ts), injected into every job as
// build-time config. This seam only turns per-app secret refs into values.
//
// REF SCHEME (the `<scheme>:<rest>` prefix selects the backend):
//   * `vault:<id>`         — the encrypted D1 vault (src/vault.ts). The home of per-APP / per-APP-ENV
//                            third-party secret VALUES (envelope-encrypted, rotatable, audited).
//   * `secretstore:<name>` — a CF Secrets Store binding entry, for infra secrets kept out of the vault.
//   * `env:NAME`           — read `NAME` from the Worker's own secret bindings. Dev/bootstrap only.
//   * `literal:VALUE`      — return VALUE verbatim. Local/test only; never store in production.
// An unknown / unresolvable ref throws (fail loud — never deploy with a missing/empty credential).

import type { Vault } from './vault'
import { parseVaultRef } from './vault'

/** Turns the registry's opaque app-secret refs into the plaintext values a deploy needs. */
export interface SecretResolver {
	/** Resolve an app secret's value from its `value_ref`. */
	resolveSecret(ref: string): Promise<string>
}

/**
 * A CF Secrets Store binding, as exposed to a Worker: each binding is a single named secret with an
 * async `get()`. A `secretstore:<name>` ref names an ENTRY in a map of these bindings. Typed
 * structurally so a real `SecretsStoreSecret` binding satisfies it (and tests can fake it).
 *
 * CF-ONLY: a real Secrets Store binding is declared in oblaka.ts / wrangler config and is only
 * exercisable against the Cloudflare runtime — there is no local emulation here. The backend below is
 * fully implemented behind the interface, but the only way to integration-test it is on real CF.
 */
export interface SecretStoreEntry {
	get(): Promise<string>
}

/**
 * The vault-backed, ref-dispatching resolver — the production `SecretResolver`.
 *
 * Dispatch by ref scheme:
 *   - `vault:<id>`         → the encrypted D1 vault (`vault`).
 *   - `secretstore:<name>` → `secretStore[name].get()` (CF Secrets Store; degrades cleanly when the
 *                            binding map is absent — a clear error rather than a wrong/empty value).
 *   - `env:NAME`           → `env[NAME]` (dev/bootstrap, from the Worker's own secret bindings).
 *   - `literal:VALUE`      → VALUE (local/test only).
 *
 * The ref's scheme, not the method, picks the backend — so an app secret can be `vault:` in production
 * and `env:`/`literal:` in dev without a code change.
 */
export class VaultSecretResolver implements SecretResolver {
	constructor(
		private readonly deps: {
			/** The encrypted D1 vault for `vault:<id>` refs (omit when no vault is configured). */
			vault?: Vault
			/** CF Secrets Store entries keyed by name, for `secretstore:<name>` refs (CF-only). */
			secretStore?: Record<string, SecretStoreEntry | undefined>
			/** The Worker's own env bindings, for `env:NAME` refs (dev/bootstrap). */
			env?: Record<string, string | undefined>
		},
	) {}

	resolveSecret(ref: string): Promise<string> {
		return this.resolve(ref, 'secret')
	}

	private async resolve(ref: string, kind: string): Promise<string> {
		const colon = ref.indexOf(':')
		if (colon === -1) {
			throw new Error(`unresolvable ${kind} ref (expected '<backend>:<id>')`)
		}
		const scheme = ref.slice(0, colon)
		const rest = ref.slice(colon + 1)

		if (scheme === 'vault') {
			if (this.deps.vault === undefined) {
				throw new Error(`cannot resolve ${kind}: vault backend not configured`)
			}
			// parseVaultRef keeps the prefix-stripping in one place; the vault re-validates the ref.
			void parseVaultRef(ref)
			return this.deps.vault.getSecret(ref)
		}

		if (scheme === 'secretstore') {
			const entry = this.deps.secretStore?.[rest]
			if (entry === undefined) {
				// CF-only path: locally there is no Secrets Store, so this fails loudly rather than
				// returning an empty/wrong credential. Names only the scheme, never the value.
				throw new Error(`cannot resolve ${kind}: Secrets Store binding not present (this backend is CF-only)`)
			}
			return entry.get()
		}

		if (scheme === 'env') {
			const value = this.deps.env?.[rest]
			if (value === undefined) {
				// Never include the ref's tail in case it is sensitive; name only the scheme.
				throw new Error(`unresolvable ${kind} ref: env var not present`)
			}
			return value
		}

		if (scheme === 'literal') {
			return rest
		}

		throw new Error(`unsupported ${kind} ref scheme: ${scheme}`)
	}
}

/**
 * The trivial v1 resolver: a ref is `env:VAR_NAME` and resolves to that environment variable's value
 * (read from a provided record — the Worker's own secret bindings), or `literal:VALUE` verbatim. Kept
 * for unit tests + local bootstrap that never touch the vault. Production uses `VaultSecretResolver`.
 *
 * Ref grammar: `env:NAME` reads `source[NAME]`; `literal:VALUE` returns VALUE verbatim (dev/local).
 * An unknown / unresolvable ref throws (fail loud — never deploy with a missing credential).
 */
export class EnvSecretResolver implements SecretResolver {
	private readonly inner: VaultSecretResolver

	constructor(source: Record<string, string | undefined>) {
		this.inner = new VaultSecretResolver({ env: source })
	}

	resolveSecret(ref: string): Promise<string> {
		return this.inner.resolveSecret(ref)
	}
}
