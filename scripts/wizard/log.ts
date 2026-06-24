/**
 * Console formatting for the bootstrap wizard — a thin, consistent presentation layer over the
 * orchestration in the other wizard modules. Every line the operator sees during bring-up flows
 * through here.
 *
 * HARD RULE (see the worker CLAUDE.md): this module NEVER prints a secret VALUE. Callers may pass
 * secret NAMES, counts, or "✓ set" confirmations — never the bytes of a token / key / PEM / webhook
 * secret. There is deliberately no helper here that takes a secret value, so a careless caller can't
 * accidentally route one through formatting.
 */

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'

let stepNo = 0

/** A numbered, bold section heading — the spine of the wizard's progress. Resets nothing else. */
export function step(title: string): void {
	stepNo += 1
	console.log(`\n${BOLD}${CYAN}[${stepNo}] ${title}${RESET}`)
}

/** A plain informational line, slightly indented under the current step. */
export function info(message: string): void {
	console.log(`    ${message}`)
}

/** A dim, secondary detail line (context the operator usually skims). */
export function detail(message: string): void {
	console.log(`    ${DIM}${message}${RESET}`)
}

/** A success line (green ✓). */
export function ok(message: string): void {
	console.log(`    ${GREEN}✓${RESET} ${message}`)
}

/** A non-fatal warning (yellow ⚠) — the wizard keeps going. */
export function warn(message: string): void {
	console.log(`    ${YELLOW}⚠${RESET} ${message}`)
}

/** A failure line (red ✗). Does NOT exit — the caller decides whether to throw. */
export function fail(message: string): void {
	console.log(`    ${RED}✗${RESET} ${message}`)
}

/**
 * A boxed OPERATOR ACTION — something the human must do out-of-band (open a URL, log in, click
 * "create", paste a value back). These are the hand-off points the whole wizard is built around, so
 * they are visually loud and never scroll past unnoticed.
 */
export function action(title: string, lines: string[]): void {
	const width = Math.max(title.length, ...lines.map((l) => stripAnsi(l).length)) + 4
	const bar = '─'.repeat(width)
	console.log(`\n${YELLOW}┌${bar}┐${RESET}`)
	console.log(`${YELLOW}│${RESET}  ${BOLD}${title}${RESET}${' '.repeat(width - title.length - 2)}${YELLOW}│${RESET}`)
	if (lines.length > 0) {
		console.log(`${YELLOW}├${bar}┤${RESET}`)
		for (const line of lines) {
			const visibleLen = stripAnsi(line).length
			console.log(`${YELLOW}│${RESET}  ${line}${' '.repeat(width - visibleLen - 2)}${YELLOW}│${RESET}`)
		}
	}
	console.log(`${YELLOW}└${bar}┘${RESET}`)
}

/** Render a URL prominently (cyan, underlined) — operators copy these by eye. */
export function url(value: string): string {
	return `${CYAN}\x1b[4m${value}${RESET}`
}

/** Strip ANSI escape codes so box-drawing can measure the VISIBLE width of a line. */
function stripAnsi(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences by design.
	return value.replace(/\x1b\[[0-9;]*m/g, '')
}
