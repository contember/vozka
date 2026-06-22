-- Vozka control plane — the encrypted secret VAULT (M4).
--
-- M3a stored only opaque REFERENCES in accounts.cf_api_token_ref / app_secrets.value_ref. This
-- migration adds the backend those `vault:<id>` refs resolve against: an at-rest-encrypted table of
-- per-app / per-env third-party secret values (envelope encryption, WebCrypto AES-256-GCM).
--
-- ENVELOPE ENCRYPTION (see src/vault.ts):
--   * each row carries its OWN random 256-bit data key (DEK) that encrypts the secret VALUE
--     (AES-256-GCM, random 96-bit `value_iv`, authenticated — tampering fails the decrypt);
--   * that DEK is itself wrapped (AES-256-GCM, random 96-bit `dek_iv`) by the MASTER key (KEK)
--     loaded from the Worker secret `VOZKA_VAULT_KEY` (32 raw bytes, base64). Plaintext DEKs and
--     plaintext values never touch D1.
-- Master-key rotation re-wraps every DEK with the new KEK (src/vault.ts reencryptAll); it never
-- needs to touch the value ciphertext, so a rotation never exposes a plaintext value.
--
-- A `vault:<id>` ref (the id is this table's PK, a UUIDv7) is what gets written back onto
-- accounts.cf_api_token_ref / app_secrets.value_ref. The vault row's own `scope`/`label` are an
-- audit/debugging aid only — they are NOT the resolution key (the ref's id is). Plaintext is NEVER
-- stored or logged.
CREATE TABLE vault (
	id          TEXT PRIMARY KEY,                       -- UUIDv7; the `<id>` in a `vault:<id>` ref
	scope       TEXT NOT NULL CHECK (scope IN ('global','account','app','app-env')),
	label       TEXT,                                   -- human handle for audit (e.g. 'app:foo/prod/API_KEY'); never the value
	ciphertext  TEXT NOT NULL,                          -- base64 AES-256-GCM ciphertext of the secret value (DEK-encrypted)
	value_iv    TEXT NOT NULL,                          -- base64 96-bit random IV for the value encryption
	wrapped_dek TEXT NOT NULL,                          -- base64 AES-256-GCM ciphertext of the 256-bit DEK (KEK-wrapped)
	dek_iv      TEXT NOT NULL,                          -- base64 96-bit random IV for the DEK wrap
	created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
	rotated_at  INTEGER                                 -- last value rotation / master-key re-wrap, once it has happened
);

CREATE INDEX idx_vault_scope ON vault(scope);
