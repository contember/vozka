/**
 * The control-plane Worker's CF bindings + vars/secrets. Single source of truth for the worker's
 * environment shape. M2 added the container + run-log bindings the runner relay needs; M3a adds the
 * control plane: D1 (registry + runs), the deploy Queue (producer + consumer), the propustka IAM
 * service binding, and the GitHub App + secret-resolver inputs.
 */
import type { IamRpc } from '@propustka/client'
import type { DeployJobMessage } from './run-lifecycle'
import type { RunnerContainer } from './RunnerContainer'

export interface Env {
	/** Control-plane SPA static assets, served for non-`/api/*`, non-webhook paths. */
	ASSETS: Fetcher
	/** Per-run deploy-runner container, backed by a Durable Object. */
	RUNNER: DurableObjectNamespace<RunnerContainer>
	/** R2 bucket the relay writes run logs + terminal status into, keyed by run id. */
	RUN_LOGS: R2Bucket
	/** Registry (accounts/apps/app_envs/app_secrets) + run history. See migrations/0001_init.sql. */
	DB: D1Database
	/** Deploy job queue — producer (trigger/webhook) + consumer (queue() handler). */
	DEPLOY_QUEUE: Queue<DeployJobMessage>
	/**
	 * propustka IAM Worker — authorization + audit over a service binding. Authentication is
	 * Cloudflare Access at the edge. OPTIONAL because it's declared off-local only; locally src/iam.ts
	 * uses FakeIamClient (DEV='true') and never touches this.
	 */
	IAM?: IamRpc

	// ── Vars ──────────────────────────────────────────────────────────────────
	ENVIRONMENT: string
	/** 'true' locally → FakeIamClient (no Access, no IAM Worker); '' off-local → real IamClient. */
	DEV: string

	// ── Secrets (provisioned out-of-band; never in oblaka.ts `vars`) ───────────
	/** GitHub App webhook secret — HMAC-verifies inbound `POST /webhooks/github`. */
	GITHUB_WEBHOOK_SECRET?: string
	/** GitHub App id (numeric string) — signs the App JWT for installation-token minting. */
	GITHUB_APP_ID?: string
	/** GitHub App PEM private key — signs the App JWT. NEVER logged. */
	GITHUB_APP_PRIVATE_KEY?: string
	/**
	 * The vault MASTER key (KEK) for the encrypted D1 secret vault — 32 raw bytes, base64. Seals every
	 * per-value data key (src/vault.ts). Provisioned out-of-band, once per environment:
	 *   `head -c 32 /dev/urandom | base64 | wrangler secret put VOZKA_VAULT_KEY`
	 * (`.dev.vars` locally). OPTIONAL on the type because the env/literal dev path never needs it; the
	 * vault management API + `vault:` ref resolution require it and fail loudly when it's absent.
	 */
	VOZKA_VAULT_KEY?: string
}
