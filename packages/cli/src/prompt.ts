/**
 * Interactive prompts for the vozka CLI, over `node:readline/promises` on the real TTY.
 *
 * `secret()` is the security-critical one: it reads a value WITHOUT echoing it to the terminal (no
 * keystrokes, no final value), so a token/key pasted at the prompt never lands in scrollback or a
 * screen-share. Every other prompt echoes normally. None of these functions ever log the value they
 * return — the caller routes secrets into a child-process env, never back through `log.ts`.
 */

import { createInterface, type Interface } from 'node:readline/promises'
import { fail, info } from './log'

/** A free-text prompt. Returns the trimmed answer, or `fallback` when the operator just hits enter. */
export async function text(question: string, fallback?: string): Promise<string> {
	const rl = openReadline()
	try {
		const suffix = fallback !== undefined && fallback !== '' ? ` [${fallback}]` : ''
		const answer = (await rl.question(`${question}${suffix}: `)).trim()
		if (answer === '' && fallback !== undefined) {
			return fallback
		}
		return answer
	} finally {
		rl.close()
	}
}

/**
 * A required free-text prompt: re-asks until the operator gives a non-empty answer (or a fallback is
 * supplied and accepted). Used for values the CLI cannot proceed without.
 */
export async function required(question: string, fallback?: string): Promise<string> {
	for (;;) {
		const value = await text(question, fallback)
		if (value !== '') {
			return value
		}
		console.log('    (a value is required)')
	}
}

/**
 * A HIDDEN-ECHO prompt for secret values. Keystrokes are not echoed and the final value is not
 * printed — the line is consumed silently. The captured value is run through `stripTerminalCruft` to
 * remove bracketed-paste markers / escape sequences some terminals inject around a paste (which would
 * otherwise corrupt a pasted token), then returned. The value is NEVER logged by this module.
 */
export async function secret(question: string): Promise<string> {
	process.stdout.write(`${question}: `)
	const rl = openReadline()
	// While reading, intercept the output stream so readline's own echo of the typed characters is
	// suppressed — only the newline at the end is allowed through, to move the cursor down.
	const muted = muteOutput()
	try {
		const answer = await rl.question('')
		return stripTerminalCruft(answer)
	} finally {
		muted.restore()
		rl.close()
		// readline swallowed the echoed newline while muted; emit one so the next line starts fresh.
		process.stdout.write('\n')
	}
}

/**
 * Strip terminal control cruft from a captured secret: bracketed-paste markers (`ESC[200~` / `ESC[201~`
 * that a terminal wraps a paste in), any other CSI escape sequence, and stray control characters. A
 * real token / key / id never contains these, so removing them is safe — and it fixes the case where a
 * paste arrives with the markers embedded (the value would otherwise be rejected as malformed).
 */
function stripTerminalCruft(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape/control bytes by design.
	return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x1f\x7f]/g, '')
}

/**
 * Read a secret from the environment (escape hatch / CI path) OR, failing that, the hidden prompt. If
 * `process.env[envName]` is set, its trimmed value is used and we log ONLY that the env var was the
 * source (never the value) — so an operator can pre-set e.g. `CLOUDFLARE_API_TOKEN=… bunx …` and
 * skip the interactive capture entirely (useful when the hidden prompt misbehaves on a given terminal).
 * Otherwise it falls back to `secret()`. The result is always trimmed.
 */
export async function secretOrEnv(envName: string, question: string): Promise<string> {
	const fromEnv = process.env[envName]
	if (fromEnv !== undefined && fromEnv.trim() !== '') {
		info(`Using ${envName} from the environment (not prompting).`)
		return fromEnv.trim()
	}
	return (await secret(question)).trim()
}

/** A yes/no confirmation. Defaults to `defaultYes` on an empty answer. */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
	const rl = openReadline()
	try {
		const hint = defaultYes ? 'Y/n' : 'y/N'
		const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase()
		if (answer === '') {
			return defaultYes
		}
		return answer === 'y' || answer === 'yes'
	} finally {
		rl.close()
	}
}

/**
 * Run an async action that VALIDATES input (verify a token, resolve a path). On a thrown error, show
 * the message and re-ask — so a typo'd or rejected value re-prompts in place instead of crashing the
 * whole CLI and losing every value already entered. Declining the retry re-throws, so the caller's
 * top-level handler still aborts cleanly. The `action` must itself re-read its inputs (do the
 * `secret()`/`text()` prompt INSIDE it) so a retry actually asks again.
 */
export async function retry<T>(label: string, action: () => Promise<T>): Promise<T> {
	for (;;) {
		try {
			return await action()
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error))
			if (!(await confirm(`${label} — try again?`, true))) {
				throw error instanceof Error ? error : new Error(String(error))
			}
		}
	}
}

/**
 * A single-choice menu. Prints the numbered options and returns the chosen value. Re-asks on an
 * out-of-range answer. With exactly one option it returns it without prompting.
 */
export async function select<T>(question: string, options: { label: string; value: T }[]): Promise<T> {
	if (options.length === 0) {
		throw new Error('select(): no options to choose from')
	}
	const only = options[0]
	if (options.length === 1 && only !== undefined) {
		return only.value
	}
	console.log(question)
	options.forEach((opt, i) => {
		console.log(`    ${i + 1}) ${opt.label}`)
	})
	const rl = openReadline()
	try {
		for (;;) {
			const answer = (await rl.question('    choose [1]: ')).trim()
			const index = answer === '' ? 0 : Number.parseInt(answer, 10) - 1
			const chosen = options[index]
			if (chosen !== undefined) {
				return chosen.value
			}
			console.log(`    (enter a number between 1 and ${options.length})`)
		}
	} finally {
		rl.close()
	}
}

/** Open a fresh readline interface bound to the process stdio. */
function openReadline(): Interface {
	return createInterface({ input: process.stdin, output: process.stdout, terminal: true })
}

/**
 * Temporarily replace `process.stdout.write` so nothing readline echoes during a secret read reaches
 * the terminal. Returns a `restore()` that puts the original back. We only mute stdout (where the
 * echo goes); stderr is untouched so a crash still surfaces.
 */
function muteOutput(): { restore: () => void } {
	const original = process.stdout.write.bind(process.stdout)
	// Swallow everything written while muted. Typed characters and the echoed value go nowhere.
	const muted: typeof process.stdout.write = () => true
	process.stdout.write = muted
	return {
		restore: () => {
			process.stdout.write = original
		},
	}
}
