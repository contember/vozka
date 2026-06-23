import { describe, expect, test } from 'bun:test'
import { isRefPattern, refMatches } from '../ref-match'

describe('isRefPattern', () => {
	test('a ref with a * is a pattern; a plain ref is not', () => {
		expect(isRefPattern('refs/tags/v*')).toBe(true)
		expect(isRefPattern('refs/tags/*')).toBe(true)
		expect(isRefPattern('refs/heads/deploy/prod')).toBe(false)
		expect(isRefPattern('refs/tags/v1.2.3')).toBe(false)
	})
})

describe('refMatches', () => {
	test('exact trigger_ref matches only the identical ref', () => {
		expect(refMatches('refs/heads/deploy/prod', 'refs/heads/deploy/prod')).toBe(true)
		expect(refMatches('refs/heads/deploy/prod', 'refs/heads/deploy/stage')).toBe(false)
		expect(refMatches('refs/tags/v1.2.3', 'refs/tags/v1.2.3')).toBe(true)
		expect(refMatches('refs/tags/v1.2.3', 'refs/tags/v1.2.4')).toBe(false)
	})

	test('a v* tag pattern matches version tags but not other refs', () => {
		expect(refMatches('refs/tags/v*', 'refs/tags/v1.2.3')).toBe(true)
		expect(refMatches('refs/tags/v*', 'refs/tags/v0.0.1-rc.1')).toBe(true)
		expect(refMatches('refs/tags/v*', 'refs/tags/release-1')).toBe(false)
		// The literal prefix is preserved — a tag pattern never matches a branch ref.
		expect(refMatches('refs/tags/v*', 'refs/heads/v-branch')).toBe(false)
	})

	test('a bare * pattern matches any tag under the prefix', () => {
		expect(refMatches('refs/tags/*', 'refs/tags/v1.2.3')).toBe(true)
		expect(refMatches('refs/tags/*', 'refs/tags/anything/nested')).toBe(true)
		expect(refMatches('refs/tags/*', 'refs/heads/main')).toBe(false)
	})

	test('regex metacharacters in the pattern are matched literally (only * is special)', () => {
		// The `.` must be a literal dot, not "any char" — so `v1x2` does NOT match `refs/tags/v1.*`.
		expect(refMatches('refs/tags/v1.*', 'refs/tags/v1.2')).toBe(true)
		expect(refMatches('refs/tags/v1.*', 'refs/tags/v1x2')).toBe(false)
	})
})
