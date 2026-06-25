import { describe, expect, test } from 'bun:test'
import { parseArgs, platformComponents } from '../cli-args'

describe('parseArgs', () => {
	test('deploy: command + flags', () => {
		const a = parseArgs(['deploy', '--env=prod', '--config=./x.ts', '--dry-run'])
		expect(a.command).toBe('deploy')
		expect(a.subcommand).toBeUndefined()
		expect(a.env).toBe('prod')
		expect(a.config).toBe('./x.ts')
		expect(a.dryRun).toBe(true)
		expect(a.buildRunnerImage).toBe(false)
	})

	test('deploy: config defaults to ./vozka.config.ts', () => {
		expect(parseArgs(['deploy', '--env=stage']).config).toBe('./vozka.config.ts')
	})

	test('platform deploy: subcommand + runner/worker configs + build flag', () => {
		const a = parseArgs([
			'platform',
			'deploy',
			'--runner-config=packages/runner/vozka-runner.config.ts',
			'--worker-config=packages/worker/vozka.config.ts',
			'--build-runner-image',
		])
		expect(a.command).toBe('platform')
		expect(a.subcommand).toBe('deploy')
		expect(a.runnerConfig).toBe('packages/runner/vozka-runner.config.ts')
		expect(a.workerConfig).toBe('packages/worker/vozka.config.ts')
		expect(a.buildRunnerImage).toBe(true)
		// env is left undefined here — main() defaults it to `prod` for platform deploy.
		expect(a.env).toBeUndefined()
	})

	test('platform deploy: --build-runner-image is off by default', () => {
		const a = parseArgs(['platform', 'deploy', '--runner-config=r.ts', '--worker-config=w.ts'])
		expect(a.buildRunnerImage).toBe(false)
	})

	test('--help is recognized', () => {
		expect(parseArgs(['--help']).help).toBe(true)
		expect(parseArgs(['-h']).help).toBe(true)
	})

	test('no args → command undefined (main prints usage)', () => {
		expect(parseArgs([]).command).toBeUndefined()
	})
})

describe('platformComponents', () => {
	test('orders vozka-runner BEFORE vozka (RUNNER_SVC binding)', () => {
		const c = platformComponents('r.ts', 'w.ts')
		expect(c.map((x) => x.label)).toEqual(['vozka-runner', 'vozka'])
		expect(c.map((x) => x.configPath)).toEqual(['r.ts', 'w.ts'])
	})

	test('throws when a config path is missing or empty', () => {
		expect(() => platformComponents(undefined, 'w.ts')).toThrow('runner-config')
		expect(() => platformComponents('', 'w.ts')).toThrow('runner-config')
		expect(() => platformComponents('r.ts', undefined)).toThrow('worker-config')
		expect(() => platformComponents('r.ts', '')).toThrow('worker-config')
	})
})
