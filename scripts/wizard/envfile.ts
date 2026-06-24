/**
 * Resume support: persist captured secrets to the `.env` the wizard already reads, so an abort (or a
 * crash) at ANY point can be recovered by simply re-running — the second run picks every value back up
 * from `.env` and SKIPS re-creating the external resources (GitHub App, propustka key, vault key) that
 * would otherwise be orphaned with their secrets lost.
 *
 * `.env` is gitignored (verified), and Bun auto-loads it for `bun run`, so a persisted value is visible
 * to the next run's `process.env` for free. Values are encoded so they survive Bun's `.env` loader
 * exactly (see `encodeEnvValue` — single-quote literal for one-liners, double-quote + `\n` for the PEM).
 *
 * This module NEVER logs a secret value — only the `.env` path and the KEY names it wrote.
 */

import { resolve } from 'node:path'

/** The `.env` the wizard persists into — the same file Bun auto-loads, resolved against the cwd. */
const ENV_PATH = resolve(process.cwd(), '.env')

/** The absolute path of the `.env` being written (for a one-time, non-secret "saving to …" log line). */
export function envPath(): string {
	return ENV_PATH
}

/** Read an env var, returning undefined for unset OR empty. Dynamic access by design (no literal-key lint). */
export function fromEnv(name: string): string | undefined {
	const value = process.env[name]
	return value !== undefined && value !== '' ? value : undefined
}

/**
 * Upsert `KEY=value` into `.env` (creating the file if absent) and reflect it into the live `process.env`
 * so the rest of THIS run sees it too. An existing `KEY=` line (with or without a leading `export`) is
 * replaced in place; otherwise the line is appended. The value is encoded so it round-trips through Bun's
 * `.env` loader. NEVER logs the value.
 */
export async function persistEnv(key: string, value: string): Promise<void> {
	const file = Bun.file(ENV_PATH)
	const existing = (await file.exists()) ? await file.text() : ''
	const lines = existing === '' ? [] : existing.split('\n')
	const newLine = `${key}=${encodeEnvValue(value)}`
	const index = lines.findIndex((line) => stripExport(line).startsWith(`${key}=`))
	if (index >= 0) {
		lines[index] = newLine
	} else {
		while (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop()
		}
		lines.push(newLine)
	}
	await Bun.write(ENV_PATH, `${lines.join('\n')}\n`)
	process.env[key] = value
}

/** Drop a leading `export ` so `KEY=` matching works whether or not the line is export-prefixed. */
function stripExport(line: string): string {
	return line.replace(/^\s*export\s+/, '')
}

/**
 * Encode a value so Bun's `.env` loader reads it back EXACTLY. Bun's quoting is quirky (all verified):
 *   - it expands `$VAR` / `${VAR}` in BOTH quote styles — so EVERY `$` is escaped to `\$` (a literal `$`),
 *   - double quotes re-expand `\n` (used for the PEM); single quotes keep `"`, `\`, backtick, `#`, spaces
 *     literal.
 * So: multi-line (only the GitHub App PEM) → double-quote + escape newlines; single-line → single-quote.
 * A single-line value cannot contain a literal `'` (Bun has no in-single-quote escape for it); a secret
 * with one is vanishingly rare, so we throw rather than silently corrupt it.
 */
function encodeEnvValue(value: string): string {
	const dollarSafe = value.replace(/\$/g, '\\$')
	if (/[\r\n]/.test(value)) {
		return `"${dollarSafe.replace(/\r/g, '').replace(/\n/g, '\\n')}"`
	}
	if (value.includes("'")) {
		throw new Error('Cannot safely persist a value containing a single quote to .env — set it manually.')
	}
	return `'${dollarSafe}'`
}
