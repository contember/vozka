// The SECRET / CREDENTIAL resolution seam.
//
// The registry stores REFERENCES, never plaintext: `accounts.cf_api_token_ref` and
// `app_secrets.value_ref`. At deploy time those refs must become actual values to put in the
// `RunnerJob` (the CF API token + the app's `pipeline.secrets` values the runner `wrangler secret
// put`s). The mapping ref → value is the ENCRYPTED VAULT — that is M4.
//
// TODO(M4): replace `EnvSecretResolver` with a vault-backed resolver that decrypts the value a ref
// points at (per-account key, rotation, audit). Everything downstream (queue consumer, job assembly)
// depends ONLY on the `SecretResolver` interface, so M4 is a swap of the implementation — no caller
// change. Resolved values are NEVER logged and live only on the in-flight `RunnerJob`.

/** Turns the registry's opaque refs into the plaintext values a deploy needs. */
export interface SecretResolver {
	/** Resolve an account's CF API token from its `cf_api_token_ref`. */
	resolveAccountToken(ref: string): Promise<string>
	/** Resolve an app secret's value from its `value_ref`. */
	resolveSecret(ref: string): Promise<string>
}

/**
 * The trivial v1 resolver: a ref is `env:VAR_NAME` and resolves to that environment variable's value
 * (read from a provided record — the Worker's own secret bindings). This is the SEAM stand-in, NOT
 * the vault: it lets the full trigger→run path work end-to-end with refs while the encrypted,
 * per-account vault is built in M4. An unknown / unresolvable ref throws (fail loud — never deploy
 * with a missing credential).
 *
 * Ref grammar (v1): `env:NAME` reads `source[NAME]`; `literal:VALUE` returns VALUE verbatim (dev/
 * local only — the registry should not store literals in production, but it keeps tests + local
 * onboarding working before the vault exists).
 */
export class EnvSecretResolver implements SecretResolver {
	constructor(private readonly source: Record<string, string | undefined>) {}

	resolveAccountToken(ref: string): Promise<string> {
		return Promise.resolve(this.resolveRef(ref, 'account token'))
	}

	resolveSecret(ref: string): Promise<string> {
		return Promise.resolve(this.resolveRef(ref, 'secret'))
	}

	private resolveRef(ref: string, kind: string): string {
		const colon = ref.indexOf(':')
		if (colon === -1) {
			throw new Error(`unresolvable ${kind} ref (expected 'env:NAME' or 'literal:VALUE')`)
		}
		const scheme = ref.slice(0, colon)
		const rest = ref.slice(colon + 1)
		if (scheme === 'literal') {
			return rest
		}
		if (scheme === 'env') {
			const value = this.source[rest]
			if (value === undefined) {
				// Never include the ref's tail in case it is sensitive; name only the scheme.
				throw new Error(`unresolvable ${kind} ref: env var not present`)
			}
			return value
		}
		throw new Error(`unsupported ${kind} ref scheme: ${scheme}`)
	}
}
