/**
 * The control-plane Worker's CF bindings + vars/secrets. Single source of truth for the
 * worker's environment shape. M0 declares only what the skeleton needs; the real control plane
 * (M3) adds the D1 / DO / queue / KV bindings that drive deploy runs.
 */
export interface Env {
	/** Control-plane SPA static assets, served for non-`/api/*` paths. */
	ASSETS: Fetcher
}
