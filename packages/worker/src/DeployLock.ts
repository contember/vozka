// Per-app-env deploy lock — a Durable Object that serializes deploys of the same (app, env). Two
// concurrent triggers for one target (a push + the manual button, or two quick pushes) would otherwise
// race on oblaka's `cf-state` KV, `wrangler deploy`, and the propustka reconcile, leaving inconsistent
// state. One DO instance per `idFromName('<app>:<env>')` gives mutual exclusion per target while
// deploys of DIFFERENT app-envs still run in parallel.
//
// The lease is NON-REENTRANT and TTL-bounded:
//   - non-reentrant: a live lease returns false even to the same holder, so a redelivered/duplicate
//     message defers instead of double-running (the run-lifecycle status guard handles same-run dedup).
//   - TTL-bounded: a consumer that dies mid-deploy (never calls release) self-heals once the lease
//     expires, rather than wedging that app-env forever. The TTL is set by the caller (longer than any
//     real deploy — see DEPLOY_LOCK_TTL_MS in src/index.ts).
// release() is holder-checked: only the run that owns the lease can clear it, so a late release() from a
// superseded run can never free a lease a newer run has since taken.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

interface Lease {
	holder: string
	expiresAt: number
}

export class DeployLock extends DurableObject<Env> {
	/**
	 * Try to take the lease for this app-env. Returns true when acquired (slot free or the prior lease
	 * has expired), false when another run holds a live lease. `holder` is the run id; `ttlMs` bounds how
	 * long the lease is honored before it's considered stale.
	 */
	async acquire(holder: string, ttlMs: number): Promise<boolean> {
		const lease = await this.ctx.storage.get<Lease>('lease')
		const now = Date.now()
		if (lease !== undefined && now < lease.expiresAt) {
			return false
		}
		await this.ctx.storage.put('lease', { holder, expiresAt: now + ttlMs } satisfies Lease)
		return true
	}

	/** Release the lease iff `holder` still owns it (idempotent; a stale holder's call is a no-op). */
	async release(holder: string): Promise<void> {
		const lease = await this.ctx.storage.get<Lease>('lease')
		if (lease !== undefined && lease.holder === holder) {
			await this.ctx.storage.delete('lease')
		}
	}
}
