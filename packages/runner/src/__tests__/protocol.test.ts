import { describe, expect, test } from 'bun:test'
import { isRunnerJob, type RunnerJob } from '../protocol'

const validJob: RunnerJob = {
	runId: 'run-1',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'main',
	env: 'prod',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
}

describe('isRunnerJob', () => {
	test('accepts a well-formed job', () => {
		expect(isRunnerJob(validJob)).toBe(true)
	})

	test('rejects non-objects and missing top-level fields', () => {
		expect(isRunnerJob(null)).toBe(false)
		expect(isRunnerJob('nope')).toBe(false)
		expect(isRunnerJob({ ...validJob, runId: 42 })).toBe(false)
		expect(isRunnerJob({ ...validJob, env: undefined })).toBe(false)
		const { credentials: _omit, ...noCreds } = validJob
		expect(isRunnerJob(noCreds)).toBe(false)
	})

	test('rejects a job whose mandatory CF credentials are missing or empty', () => {
		// The whole point of the strengthened guard: never start a deploy that would authenticate blank.
		expect(isRunnerJob({ ...validJob, credentials: {} })).toBe(false)
		expect(isRunnerJob({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct' } })).toBe(false)
		expect(isRunnerJob({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: 'tok' } })).toBe(false)
		expect(isRunnerJob({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: '' } })).toBe(false)
	})
})
