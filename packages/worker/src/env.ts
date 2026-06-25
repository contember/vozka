/**
 * The control-plane Worker's CF bindings + vars/secrets. Single source of truth for the worker's
 * environment shape. M2 added the container + run-log bindings the runner relay needs; M3a adds the
 * control plane: D1 (registry + runs), the deploy Queue (producer + consumer), the propustka IAM
 * service binding, and the GitHub App + secret-resolver inputs.
 */
import type { IamRpc } from '@propustka/client'
import type { VozkaRunner } from '@vozka/runner'
import type { DeployLock } from './DeployLock'
import type { DeployJobMessage } from './run-lifecycle'

export interface Env {
	/** Control-plane SPA static assets, served for non-`/api/*`, non-webhook paths. */
	ASSETS: Fetcher
	/**
	 * vozka-runner — the deploy EXECUTOR, over a service binding. The control plane hands a run to it
	 * (`RUNNER_SVC.startRun(job)`); vozka-runner boots the container, relays logs → R2, and records the
	 * terminal status → D1. Split into its own worker so a deploy of vozka never resets the container
	 * running that deploy. OPTIONAL because it's declared off-local only (local dev has no runner worker,
	 * mirroring the IAM binding); `startRun` fails loudly if a real deploy is triggered locally.
	 */
	RUNNER_SVC?: Service<VozkaRunner>
	/** Per-app-env deploy lock (one DO instance per `<app>:<env>`) — serializes deploys of one target. */
	DEPLOY_LOCK: DurableObjectNamespace<DeployLock>
	/** R2 bucket run logs + terminal status are written into (by vozka-runner), keyed by run id; read by the API. */
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
	/** Public domain this stage serves on (drives absolute URLs); empty when unknown. */
	VOZKA_DOMAIN?: string
	/**
	 * The SINGLE Cloudflare account every deploy targets (vozka is single-account: propustka + vozka +
	 * the apps it deploys all live on one account). Not secret — injected into every deploy job's
	 * `CLOUDFLARE_ACCOUNT_ID`. See migrations/0003 (the per-account registry was removed).
	 */
	CLOUDFLARE_ACCOUNT_ID?: string
	/**
	 * propustka IAM base URL injected into every deploy so an app reconciles its schema/access into
	 * propustka. Platform-wide (one propustka per account); WHETHER a deploy reconciles is decided by
	 * the app's own config (`access`/`schema` presence), not the registry.
	 */
	PROPUSTKA_URL?: string
	/**
	 * JSON array of bootstrap-admin emails (normally `'[]'`). When a caller's email is in this list,
	 * src/iam.ts authorizes them as admin even if propustka denies / the IAM binding isn't wired yet —
	 * the escape hatch for the FIRST operator before propustka knows about vozka. Mirrors propustka's
	 * own IAM_BOOTSTRAP_ADMINS. Set by scripts/bootstrap.ts for initial bring-up; emptied afterwards.
	 */
	VOZKA_BOOTSTRAP_ADMINS?: string

	// ── Secrets (provisioned out-of-band; never in oblaka.ts `vars`) ───────────
	/** GitHub App webhook secret — HMAC-verifies inbound `POST /webhooks/github`. */
	GITHUB_WEBHOOK_SECRET?: string
	/** GitHub App id (numeric string) — signs the App JWT for installation-token minting. */
	GITHUB_APP_ID?: string
	/** GitHub App PEM private key — signs the App JWT. NEVER logged. */
	GITHUB_APP_PRIVATE_KEY?: string
	/**
	 * The Cloudflare API token vozka deploys with (account-wide) — injected into every deploy job's
	 * `CLOUDFLARE_API_TOKEN`. Single-account: one token for the whole control plane. NEVER logged.
	 */
	CLOUDFLARE_API_TOKEN?: string
	/** propustka admin OAuth client id (vozka's provisioning key) — injected for the reconcile step. NEVER logged. */
	PROPUSTKA_CLIENT_ID?: string
	/** propustka admin OAuth client secret (vozka's provisioning key). NEVER logged. */
	PROPUSTKA_CLIENT_SECRET?: string
	/**
	 * The vault MASTER key (KEK) for the encrypted D1 secret vault — 32 raw bytes, base64. Seals every
	 * per-value data key (src/vault.ts). Provisioned out-of-band, once per environment:
	 *   `head -c 32 /dev/urandom | base64 | wrangler secret put VOZKA_VAULT_KEY`
	 * (`.dev.vars` locally). OPTIONAL on the type because the env/literal dev path never needs it; the
	 * vault management API + `vault:` ref resolution require it and fail loudly when it's absent.
	 */
	VOZKA_VAULT_KEY?: string
}
