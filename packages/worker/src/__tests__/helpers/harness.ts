// Shared test harness for the control-plane worker. Stands up a real in-memory `bun:sqlite` DB with
// the production migrations applied, wrapped in a small D1-compatible adapter so `new Db(...)` runs
// against it EXACTLY as it does over D1 (mirrors propustka's harness). Nothing here mocks the modules
// under test — the SQL runs against the real schema.

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Db } from '../../db'

// ── Cumulative migrations (every migrations/*.sql, filename order) ─────────────

export function allMigrations(): string {
	const dir = join(import.meta.dir, '..', '..', '..', 'migrations')
	return readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((f) => readFileSync(join(dir, f), 'utf8'))
		.join('\n')
}

// ── D1-compatible adapter over bun:sqlite (mirrors propustka's harness) ─────────

class TestD1PreparedStatement implements D1PreparedStatement {
	private params: SQLQueryBindings[] = []

	constructor(private readonly db: Database, private readonly sql: string) {}

	bind(...values: unknown[]): D1PreparedStatement {
		const next = new TestD1PreparedStatement(this.db, this.sql)
		next.params = values.map((v) => toBinding(v))
		return next
	}

	first<T = Record<string, unknown>>(colName: string): Promise<T | null>
	first<T = Record<string, unknown>>(): Promise<T | null>
	first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
		const row = this.db.query<T, SQLQueryBindings[]>(this.sql).get(...this.params)
		if (row === null) {
			return Promise.resolve(null)
		}
		if (colName !== undefined) {
			return Promise.resolve(pluck<T>(row, colName))
		}
		return Promise.resolve(row)
	}

	all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const results = this.db.query<T, SQLQueryBindings[]>(this.sql).all(...this.params)
		return Promise.resolve(this.wrap(results))
	}

	run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const changes = this.db.query<T, SQLQueryBindings[]>(this.sql).run(...this.params)
		const result = this.wrap<T>([])
		result.meta.changes = changes.changes
		return Promise.resolve(result)
	}

	raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
	raw<T = unknown[]>(_options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
		throw new Error('raw() is not used by Db and is not implemented in the test adapter')
	}

	private wrap<T>(results: T[]): D1Result<T> {
		return {
			results,
			success: true,
			meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 },
		}
	}
}

class TestD1Database implements D1Database {
	constructor(private readonly db: Database) {}

	prepare(query: string): D1PreparedStatement {
		return new TestD1PreparedStatement(this.db, query)
	}

	async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		const out: D1Result<T>[] = []
		this.db.run('BEGIN')
		try {
			for (const stmt of statements) {
				out.push(await stmt.all<T>())
			}
			this.db.run('COMMIT')
		} catch (err) {
			this.db.run('ROLLBACK')
			throw err
		}
		return out
	}

	exec(_query: string): Promise<D1ExecResult> {
		throw new Error('exec() is not used by Db and is not implemented in the test adapter')
	}

	withSession(_constraintOrBookmark?: string): D1DatabaseSession {
		throw new Error('withSession() is not used by Db and is not implemented in the test adapter')
	}

	dump(): Promise<ArrayBuffer> {
		throw new Error('dump() is not used by Db and is not implemented in the test adapter')
	}
}

/** Narrow a single result row to one named column (kept honest via a JSON round-trip; no casts). */
function pluck<T>(row: T, colName: string): T | null {
	const box: { v: unknown } = { v: row }
	const reread: { v: Record<string, unknown> } = JSON.parse(JSON.stringify(box))
	const value: unknown = reread.v[colName]
	if (value === undefined || value === null) {
		return null
	}
	const out: { v: T } = JSON.parse(JSON.stringify({ v: value }))
	return out.v
}

/** Coerce a bound value into a bun:sqlite-acceptable binding (no `as`). */
function toBinding(value: unknown): SQLQueryBindings {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
		return value
	}
	if (value === undefined) {
		return null
	}
	throw new Error(`unsupported bind value of type ${typeof value}`)
}

// ── Harness assembly ────────────────────────────────────────────────────────

const migration = allMigrations()

export interface Harness {
	/** Raw sqlite connection — seed rows / assert directly. */
	sqlite: Database
	/** The production `Db` over the in-memory sqlite, via the D1 adapter. */
	db: Db
	/** The D1-compatible handle over the SAME sqlite — pass to other D1 consumers (e.g. `Vault`). */
	d1: D1Database
}

/** Stand up a fresh in-memory DB + Db. Call once per test for isolation. */
export function createHarness(): Harness {
	const sqlite = new Database(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	sqlite.exec(migration)
	const d1 = new TestD1Database(sqlite)
	const db = new Db(d1)
	return { sqlite, db, d1 }
}

/**
 * Read every row of a sqlite query as plain objects (a JSON round-trip keeps it honest without an
 * `as` cast). Test-only helper for asserting on raw stored rows (e.g. that no plaintext is present).
 */
export function queryRows(sqlite: Database, sql: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
	const rows = sqlite.query(sql).all(...params)
	const reread: { rows: Record<string, unknown>[] } = JSON.parse(JSON.stringify({ rows }))
	return reread.rows
}

// ── HMAC + webhook helpers (sign a body the way GitHub would) ──────────────────

/** Sign a raw body with HMAC-SHA256 (hex), as GitHub's `X-Hub-Signature-256` header value. */
export async function signWebhook(rawBody: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
	const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
	return `sha256=${hex}`
}

/** Build a GitHub push-webhook Request with a valid (or supplied) signature. */
export async function pushWebhookRequest(options: {
	ref: string
	cloneUrl: string
	after?: string
	installationId?: number
	secret: string
	signatureOverride?: string
}): Promise<Request> {
	const body = JSON.stringify({
		ref: options.ref,
		after: options.after ?? 'deadbeef',
		repository: { clone_url: options.cloneUrl },
		...(options.installationId !== undefined ? { installation: { id: options.installationId } } : {}),
	})
	const signature = options.signatureOverride ?? (await signWebhook(body, options.secret))
	return new Request('https://vozka.example/webhooks/github', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'X-Hub-Signature-256': signature },
		body,
	})
}
