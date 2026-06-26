/**
 * Scaffold the per-account base repo `<org>/vozka-platform`: ensure it exists on GitHub, materialize the
 * pipeline (`.github/workflows/platform.yml`), `vozka.ref`, `README.md`, `.gitignore` from the templates
 * checked into this package, and push. Idempotent:
 *   - repo absent  → create a fresh local checkout, commit the scaffold, `gh repo create … --source --push`,
 *   - repo present → clone it (if not already local), refresh the CLI-owned files, commit + push on drift.
 *
 * `vozka.ref` is written ONLY when absent (operator-owned after creation — bumping it is how you roll a new
 * base); `platform.yml` / `README.md` / `.gitignore` are CLI-owned and refreshed every run.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ghRepoExists, hasGhCli } from './gh'
import { detail, ok, step } from './log'
import { probe, run } from './shell'

const TEMPLATES = resolve(import.meta.dir, 'templates')

/** The CLI-owned files, refreshed on every run (rendered from templates). */
const OWNED_FILES = ['.gitignore', 'README.md', '.github/workflows/platform.yml']
/** All scaffold files we ever `git add` (OWNED_FILES + the operator-owned, write-once `vozka.ref`). */
const ALL_FILES = ['.gitignore', 'README.md', 'vozka.ref', '.github/workflows/platform.yml']

export interface ScaffoldInput {
	/** The base repo, e.g. `manGoweb/vozka-platform`. */
	repo: string
	/** The account label (positional `init` arg) — substituted into the templates + the env/summary names. */
	account: string
	/** Local directory to check the repo out into. */
	dir: string
}

/** Result of scaffolding: the local checkout dir + whether the repo was freshly created. */
export interface ScaffoldResult {
	dir: string
	created: boolean
}

/** Render a template: replace every `{{ACCOUNT}}` token. (Account is the only placeholder today.) */
async function renderTemplate(name: string, account: string): Promise<string> {
	const raw = await Bun.file(resolve(TEMPLATES, name)).text()
	return raw.replaceAll('{{ACCOUNT}}', account)
}

/** Write the file at `rel` under `dir` with `content`, creating parent dirs as needed. */
async function writeFile(dir: string, rel: string, content: string): Promise<void> {
	await Bun.write(resolve(dir, rel), content)
}

/** Materialize the CLI-owned files (rendered) + `vozka.ref` only when absent. */
async function materialize(dir: string, account: string): Promise<void> {
	await writeFile(dir, '.gitignore', await Bun.file(resolve(TEMPLATES, 'gitignore')).text())
	await writeFile(dir, 'README.md', await renderTemplate('README.md', account))
	await writeFile(dir, '.github/workflows/platform.yml', await renderTemplate('platform.yml', account))
	if (!existsSync(resolve(dir, 'vozka.ref'))) {
		await writeFile(dir, 'vozka.ref', await Bun.file(resolve(TEMPLATES, 'vozka.ref')).text())
	}
}

/** True when the staged tree has changes to commit (`git diff --cached --quiet` exits 1 on drift). */
async function hasStagedChanges(dir: string): Promise<boolean> {
	return (await probe({ command: 'git', args: ['diff', '--cached', '--quiet'], cwd: dir })) !== 0
}

/**
 * Ensure `<org>/vozka-platform` exists + carries the current scaffold. Returns the local checkout dir.
 * Requires `gh` authed with rights to create/admin the repo.
 */
export async function scaffoldPlatformRepo(input: ScaffoldInput): Promise<ScaffoldResult> {
	step(`Scaffold the platform repo (${input.repo})`)
	if (!(await hasGhCli())) {
		throw new Error('`gh` (GitHub CLI) is required — install it and run `gh auth login`.')
	}

	const exists = await ghRepoExists(input.repo)
	if (exists) {
		return updateExisting(input)
	}
	return createFresh(input)
}

/** Repo already exists: clone if needed, refresh CLI-owned files, commit + push on drift. */
async function updateExisting(input: ScaffoldInput): Promise<ScaffoldResult> {
	const { repo, account, dir } = input
	if (!existsSync(resolve(dir, '.git'))) {
		detail(`Cloning ${repo} → ${dir}`)
		await run({ command: 'gh', args: ['repo', 'clone', repo, dir], cwd: process.cwd() })
	} else {
		detail(`Reusing existing checkout at ${dir}`)
	}
	await materialize(dir, account)
	await run({ command: 'git', args: ['add', ...ALL_FILES], cwd: dir })
	if (!(await hasStagedChanges(dir))) {
		ok('Platform repo already up to date (no scaffold drift).')
		return { dir, created: false }
	}
	await run({ command: 'git', args: ['commit', '-m', 'chore: refresh vozka platform scaffold'], cwd: dir })
	await run({ command: 'git', args: ['push'], cwd: dir })
	ok('Platform repo scaffold updated + pushed.')
	return { dir, created: false }
}

/** Repo does not exist: build a local checkout, commit the scaffold, create + push in one `gh` call. */
async function createFresh(input: ScaffoldInput): Promise<ScaffoldResult> {
	const { repo, account, dir } = input
	if (existsSync(resolve(dir, '.git'))) {
		throw new Error(`${dir} is already a git repo but ${repo} does not exist on GitHub — resolve the mismatch by hand.`)
	}
	detail(`Creating a fresh checkout at ${dir}`)
	await run({ command: 'git', args: ['init', '-b', 'main', dir], cwd: process.cwd() })
	await materialize(dir, account)
	await run({ command: 'git', args: ['add', ...ALL_FILES], cwd: dir })
	await run({ command: 'git', args: ['commit', '-m', 'chore: initial vozka platform scaffold'], cwd: dir })
	detail(`Creating ${repo} (private) and pushing`)
	await run({
		command: 'gh',
		args: ['repo', 'create', repo, '--private', '--source', dir, '--remote', 'origin', '--push'],
		cwd: process.cwd(),
	})
	ok(`Platform repo ${repo} created + pushed.`)
	return { dir, created: true }
}

/** The default local checkout dir for an account: `./vozka-platform-<account>` under the cwd. */
export function defaultCheckoutDir(account: string): string {
	return resolve(process.cwd(), `vozka-platform-${account}`)
}

/** Read the configured `vozka.ref` (for display), or 'main' when absent. Used in the final summary. */
export async function readVozkaRef(dir: string): Promise<string> {
	const file = Bun.file(resolve(dir, 'vozka.ref'))
	if (!(await file.exists())) {
		return 'main'
	}
	return (await file.text()).trim() || 'main'
}
