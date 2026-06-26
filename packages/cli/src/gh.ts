/**
 * `gh` CLI helpers. The CLI shells out to `gh` for everything GitHub-side (repo create, secrets, the
 * deploy trigger) rather than re-implementing the REST API + libsodium secret encryption — `gh` already
 * does the encryption for `secret set`. These are the small probes shared across scaffold + environment.
 */

import { probe } from './shell'

/** The repo root — a harmless cwd anchor for `gh` shell-outs (gh ignores cwd when `--repo` is given). */
const ANCHOR = process.cwd()

/** Is the `gh` CLI available + authenticated? `gh auth status` exits non-zero when not logged in. */
export async function hasGhCli(): Promise<boolean> {
	try {
		return (await probe({ command: 'gh', args: ['auth', 'status'], cwd: ANCHOR })) === 0
	} catch {
		return false
	}
}

/** Does `<org>/<repo>` exist and is it visible to the current `gh` login? */
export async function ghRepoExists(repo: string): Promise<boolean> {
	return (await probe({ command: 'gh', args: ['repo', 'view', repo, '--json', 'nameWithOwner'], cwd: ANCHOR })) === 0
}
