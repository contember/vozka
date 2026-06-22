import { describe, expect, test } from 'bun:test'
import { fmtDuration, qs, shortRef, shortSha } from '../lib/format'

// Pure formatting helpers used across the dashboard. No DOM — just the deterministic transforms.

describe('shortSha', () => {
	test('takes the first 7 chars', () => {
		expect(shortSha('0123456789abcdef')).toBe('0123456')
	})
	test('renders an em dash for null/empty', () => {
		expect(shortSha(null)).toBe('—')
		expect(shortSha('')).toBe('—')
		expect(shortSha(undefined)).toBe('—')
	})
})

describe('shortRef', () => {
	test('drops the refs/heads/ prefix', () => {
		expect(shortRef('refs/heads/main')).toBe('main')
		expect(shortRef('refs/heads/deploy/prod')).toBe('deploy/prod')
	})
	test('drops the refs/tags/ prefix', () => {
		expect(shortRef('refs/tags/v1.2.3')).toBe('v1.2.3')
	})
	test('leaves a bare ref untouched', () => {
		expect(shortRef('main')).toBe('main')
		expect(shortRef('deadbeef')).toBe('deadbeef')
	})
})

describe('fmtDuration', () => {
	test('seconds only under a minute', () => {
		expect(fmtDuration(100, 142)).toBe('42s')
	})
	test('minutes and seconds past a minute', () => {
		expect(fmtDuration(100, 172)).toBe('1m 12s')
	})
	test('clamps a negative span to zero', () => {
		expect(fmtDuration(200, 100)).toBe('0s')
	})
	test('em dash when either bound is missing', () => {
		expect(fmtDuration(null, 100)).toBe('—')
		expect(fmtDuration(100, null)).toBe('—')
		expect(fmtDuration(undefined, undefined)).toBe('—')
	})
})

describe('qs', () => {
	test('builds a query string, skipping empty/null/undefined values', () => {
		expect(qs({ app: 'acme', env: '', limit: 50, before: null, cursor: undefined })).toBe('?app=acme&limit=50')
	})
	test('is empty when nothing meaningful is set', () => {
		expect(qs({ a: '', b: null, c: undefined })).toBe('')
	})
	test('url-encodes values', () => {
		expect(qs({ env: 'a b' })).toBe('?env=a+b')
	})
})
