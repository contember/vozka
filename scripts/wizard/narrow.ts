/**
 * Tiny runtime narrowing helpers for the wizard's JSON handling. CF + GitHub responses arrive as
 * `unknown`; we validate them structurally instead of casting (the repo bans `as` outside `as const`).
 *
 * The trick: `isRecord` is a type GUARD whose return type (`value is Record<string, unknown>`)
 * narrows the value for the compiler — no cast at the call site. `prop()` then reads a single field
 * as `unknown`, which the caller checks with `typeof` before trusting. This keeps every response shape
 * validated at runtime with zero `as`.
 */

/** Is `value` a non-null object we can index by string key? Narrows to `Record<string, unknown>`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object'
}

/** Read `key` off an unknown value as `unknown` (undefined when not a record / key absent). */
export function prop(value: unknown, key: string): unknown {
	if (!isRecord(value)) {
		return undefined
	}
	return value[key]
}

/** Read `key` as a string, or undefined when missing / not a string. */
export function stringProp(value: unknown, key: string): string | undefined {
	const v = prop(value, key)
	return typeof v === 'string' ? v : undefined
}

/** Read `key` as a number, or undefined when missing / not a number. */
export function numberProp(value: unknown, key: string): number | undefined {
	const v = prop(value, key)
	return typeof v === 'number' ? v : undefined
}
