// Matching a registered env's `trigger_ref` against a concrete git ref. A trigger_ref is normally an
// exact ref (`refs/heads/deploy/prod`), but may be a GLOB (contains `*`) so an env can subscribe to a
// FAMILY of refs — most usefully release tags: `refs/tags/v*` deploys on every `v…` tag push (webhook)
// or the newest matching tag (poll). The concrete ref to deploy is always resolved at trigger time (the
// pushed ref, or the resolved tag) — never the pattern itself.

/** A trigger_ref is a PATTERN when it contains a `*` glob; otherwise it's an exact git ref. */
export function isRefPattern(triggerRef: string): boolean {
	return triggerRef.includes('*')
}

/**
 * Does a concrete git ref match an env's `trigger_ref`? Exact string equality unless the trigger_ref is
 * a glob, where `*` matches any run of characters. The literal `refs/heads/` or `refs/tags/` prefix is
 * preserved, so a tag pattern (`refs/tags/v*`) never matches a branch ref and vice versa.
 */
export function refMatches(triggerRef: string, ref: string): boolean {
	if (!isRefPattern(triggerRef)) {
		return triggerRef === ref
	}
	return globToRegExp(triggerRef).test(ref)
}

/** Compile a `*`-glob to an anchored RegExp: escape every regex metachar, then `\*` → `.*`. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
	return new RegExp(`^${escaped}$`)
}
