// Offline full-path proof: run deploy() in dry-run with a fake provisioner (oblaka's real deploy()
// always hits the cf-state KV even in dryRun, so we substitute just that collaborator — exactly the
// injection seam the engine is built around). Everything else is the real engine + real fixture.
import { deploy } from '../src/deploy'
import { defaultRuntime, type DeployRuntime } from '../src/runtime'
import type { DeployContext } from '../src/types'
import config from './vozka.config'

const runtime: DeployRuntime = {
	...defaultRuntime,
	provision: async (input) => {
		console.log(`  [fake-oblaka] materialized graph for ${input.env}, dryRun=${input.dryRun}`)
		return {
			wranglerConfigs: [{ path: 'wrangler.jsonc', config: { name: `${input.env}-sample` }, content: '{}' }],
			wranglerConfig: { name: `${input.env}-sample` },
		}
	},
}

const ctx: DeployContext = {
	env: 'stage',
	domain: 'stage.sample.example.com',
	accountId: 'dummy-acc',
	apiToken: 'dummy-tok',
	propustkaUrl: 'https://iam.example.com',
	clientId: 'cid',
	clientSecret: 'csec',
	secrets: { SAMPLE_API_KEY: 'dummy-secret' },
	cwd: import.meta.dir,
	dryRun: true,
}

const result = await deploy(config, ctx, runtime)
console.log('\n=== RESULT ===')
console.log('overall:', result.status)
for (const s of result.steps) console.log(' ', s.status.padEnd(10), s.spec.id)
process.exit(result.status === 'failed' ? 1 : 0)
