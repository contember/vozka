import { describe, expect, test } from 'bun:test'
import type { RunnerJob } from '../protocol'
import { Runner, type RunnerEnv, type SpawnHandlers, type SpawnResult, type SpawnSpec } from '../runner'

// The Runner routes every child process through an injected `Spawner`, so these tests drive a full
// clone → install → vozka-deploy pipeline with a fake — no git, no network, no real deploy.

interface RecordedSpawn {
	spec: SpawnSpec
}

/** A scripted spawner: emits canned stdout/stderr per command and returns a chosen exit code. */
const makeSpawner = (
	rec: RecordedSpawn[],
	script: (spec: SpawnSpec, handlers: SpawnHandlers) => SpawnResult,
) =>
async (spec: SpawnSpec, handlers: SpawnHandlers): Promise<SpawnResult> => {
	rec.push({ spec })
	return script(spec, handlers)
}

const baseJob = (overrides: Partial<RunnerJob> = {}): RunnerJob => ({
	runId: 'run-1',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'main',
	env: 'stage',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: 'tok-abcdef' },
	...overrides,
})

const makeEnv = (spawn: RunnerEnv['spawn']): RunnerEnv => ({ spawn, workspace: '/workspace' })

describe('Runner pipeline', () => {
	test('clone → install → deploy: faithful argv + cwd, success status with exit 0', async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, (spec, handlers) => {
			handlers.onStdout(`ran ${spec.command}\n`)
			return { exitCode: 0 }
		})
		const runner = new Runner(baseJob({ workerDir: 'worker', configPath: 'vozka.config.ts', dryRun: true }), makeEnv(spawn))
		const status = await runner.run()

		expect(rec.map((r) => r.spec.command)).toEqual(['git', 'bun', 'vozka'])
		// clone into the run-keyed checkout dir
		expect(rec[0]?.spec.args).toEqual(['clone', '--depth', '1', '--branch', 'main', 'https://github.com/acme/app.git', '/workspace/run-1'])
		// install + deploy run in workerDir
		expect(rec[1]?.spec).toMatchObject({ command: 'bun', args: ['install'], cwd: '/workspace/run-1/worker' })
		// deploy is faithful to M1's CLI contract
		expect(rec[2]?.spec).toMatchObject({
			command: 'vozka',
			args: ['deploy', '--env=stage', '--config=vozka.config.ts', '--dry-run'],
			cwd: '/workspace/run-1/worker',
		})

		expect(status.state).toBe('succeeded')
		expect(status.exitCode).toBe(0)
		expect(typeof status.finishedAt).toBe('number')
	})

	test('strips refs/heads|tags/ from the ref for `git clone --branch` (a short name passes through)', async () => {
		const recHeads: RecordedSpawn[] = []
		await new Runner(baseJob({ ref: 'refs/heads/main', dryRun: true }), makeEnv(makeSpawner(recHeads, () => ({ exitCode: 0 })))).run()
		expect(recHeads[0]?.spec.args).toEqual(['clone', '--depth', '1', '--branch', 'main', 'https://github.com/acme/app.git', '/workspace/run-1'])

		const recTags: RecordedSpawn[] = []
		await new Runner(baseJob({ ref: 'refs/tags/v1.2.3', dryRun: true }), makeEnv(makeSpawner(recTags, () => ({ exitCode: 0 })))).run()
		expect(recTags[0]?.spec.args[4]).toBe('v1.2.3')
	})

	test('credentials + secrets go into the deploy child env (never argv)', async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, () => ({ exitCode: 0 }))
		const job = baseJob({
			domain: 'stage.acme.com',
			credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: 'tok-abcdef', PROPUSTKA_URL: 'https://iam.acme.com' },
			secrets: { SAMPLE_API_KEY: 'super-secret-value' },
		})
		await new Runner(job, makeEnv(spawn)).run()

		const deploy = rec.find((r) => r.spec.command === 'vozka')?.spec
		expect(deploy?.env).toMatchObject({
			CLOUDFLARE_ACCOUNT_ID: 'acc-123456',
			CLOUDFLARE_API_TOKEN: 'tok-abcdef',
			PROPUSTKA_URL: 'https://iam.acme.com',
			VOZKA_DOMAIN: 'stage.acme.com',
			SAMPLE_API_KEY: 'super-secret-value',
		})
		// No secret/cred value ever appears on argv.
		const argvAll = rec.flatMap((r) => r.spec.args).join(' ')
		expect(argvAll).not.toContain('super-secret-value')
		expect(argvAll).not.toContain('tok-abcdef')
	})

	test('secret + credential values are redacted from log lines', async () => {
		const spawn = makeSpawner([], (spec, handlers) => {
			if (spec.command === 'vozka') {
				handlers.onStdout('deploying with token tok-abcdef and key super-secret-value\n')
			}
			return { exitCode: 0 }
		})
		const job = baseJob({ secrets: { SAMPLE_API_KEY: 'super-secret-value' } })
		const runner = new Runner(job, makeEnv(spawn))
		await runner.run()

		const joined = runner.lines().map((l) => l.text).join('\n')
		expect(joined).not.toContain('tok-abcdef')
		expect(joined).not.toContain('super-secret-value')
		expect(joined).toContain('***')
	})

	test('clone failure stops the pipeline (no install/deploy) and fails the run', async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, (spec) => ({ exitCode: spec.command === 'git' ? 128 : 0 }))
		const status = await new Runner(baseJob(), makeEnv(spawn)).run()

		expect(rec.map((r) => r.spec.command)).toEqual(['git'])
		expect(status.state).toBe('failed')
		expect(status.error).toContain('git clone failed')
		expect(status.exitCode).toBeUndefined()
	})

	test('non-zero vozka deploy exit fails the run and carries the exit code', async () => {
		const spawn = makeSpawner([], (spec) => ({ exitCode: spec.command === 'vozka' ? 1 : 0 }))
		const status = await new Runner(baseJob(), makeEnv(spawn)).run()
		expect(status.state).toBe('failed')
		expect(status.exitCode).toBe(1)
	})

	test('subscribers receive streamed lines live', async () => {
		const seen: string[] = []
		const spawn = makeSpawner([], (spec, handlers) => {
			if (spec.command === 'vozka') {
				handlers.onStdout('line-a\nline-b\n')
			}
			return { exitCode: 0 }
		})
		const runner = new Runner(baseJob(), makeEnv(spawn))
		runner.subscribe((line) => {
			if (line.stream === 'stdout') {
				seen.push(line.text)
			}
		})
		await runner.run()
		expect(seen).toContain('line-a')
		expect(seen).toContain('line-b')
	})
})
