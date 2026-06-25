import { describe, expect, test } from 'bun:test'
import { createHarness, queryRows } from './helpers/harness'

// Db.sweepStaleRuns is the cron-driven backstop-to-the-backstop: it reaps runs left in pending/running
// past the age threshold (the per-run DO backstop should have finished them within ~18 min). Driven
// against the harness's real bun:sqlite with the production migrations, inserting runs at controlled ages.

describe('Db.sweepStaleRuns', () => {
	test('reaps stale pending/running runs, spares recent + already-terminal ones', async () => {
		const { db, sqlite } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod' })

		const OLD = 40 * 60 // beyond the 30-min threshold
		const RECENT = 5 * 60 // within it
		sqlite.exec(`
			INSERT INTO runs (id, app_id, env, ref, trigger, status, created_at, started_at) VALUES
				('old-running',   'app','prod','refs/heads/main','manual','running',   unixepoch()-${OLD},    unixepoch()-${OLD}),
				('new-running',   'app','prod','refs/heads/main','manual','running',   unixepoch()-${RECENT}, unixepoch()-${RECENT}),
				('old-pending',   'app','prod','refs/heads/main','manual','pending',   unixepoch()-${OLD},    NULL),
				('old-succeeded', 'app','prod','refs/heads/main','manual','succeeded', unixepoch()-${OLD},    unixepoch()-${OLD})
		`)

		const swept = await db.sweepStaleRuns(30 * 60)
		expect(swept).toBe(2) // old-running + old-pending

		const statusOf = (id: string): unknown => queryRows(sqlite, 'SELECT status FROM runs WHERE id = ?', id)[0]?.status
		expect(statusOf('old-running')).toBe('failed')
		expect(statusOf('old-pending')).toBe('failed') // aged on created_at when started_at is NULL
		expect(statusOf('new-running')).toBe('running') // recent — never reaped
		expect(statusOf('old-succeeded')).toBe('succeeded') // terminal — untouched
		// A swept run gets finished_at stamped.
		expect(queryRows(sqlite, 'SELECT finished_at FROM runs WHERE id = ?', 'old-running')[0]?.finished_at).not.toBeNull()
	})

	test('a fresh run loop is never reaped (the age guard protects in-flight deploys)', async () => {
		const { db, sqlite } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod' })
		sqlite.exec(
			`INSERT INTO runs (id, app_id, env, ref, trigger, status) VALUES ('fresh','app','prod','refs/heads/main','manual','running')`,
		)
		expect(await db.sweepStaleRuns(30 * 60)).toBe(0)
		expect(queryRows(sqlite, 'SELECT status FROM runs WHERE id = ?', 'fresh')[0]?.status).toBe('running')
	})
})
