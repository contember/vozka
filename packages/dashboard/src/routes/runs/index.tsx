import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { RunStatusBadge } from '../../components/Badge'
import { Table } from '../../components/Table'
import { api, ApiError, type AppDto, type CursorList, type ListResponse, type RunDto } from '../../lib/api'
import { fmtDate, qs, shortRef, shortSha } from '../../lib/format'

// Runs — the global deploy history. Filter by app and/or env; keyset-paged with `?before=`. Each row
// links to the run detail (which tails the live log). A per-app view is the same table prefiltered.

const PAGE_SIZE = 50

export default createPage()
	.loader(async () => {
		const [runs, apps] = await Promise.all([
			api.get<CursorList<RunDto>>(`/runs${qs({ limit: PAGE_SIZE })}`),
			api.get<ListResponse<AppDto>>('/apps'),
		])
		return { initialRuns: runs, apps: apps.items }
	})
	.route('/runs')
	.render(({ data }) => {
		const [app, setApp] = useState('')
		const [env, setEnv] = useState('')
		const [runs, setRuns] = useState<RunDto[]>(data.initialRuns.items)
		const [cursor, setCursor] = useState<string | null>(data.initialRuns.nextCursor)
		const [loading, setLoading] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function load(reset: boolean) {
			setLoading(true)
			setError(null)
			try {
				const before = reset ? undefined : (cursor ?? undefined)
				const page = await api.get<CursorList<RunDto>>(
					`/runs${qs({ app, env, before, limit: PAGE_SIZE })}`,
				)
				setRuns((prev) => (reset ? page.items : [...prev, ...page.items]))
				setCursor(page.nextCursor)
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Failed to load runs.')
			} finally {
				setLoading(false)
			}
		}

		function applyFilters(e: React.FormEvent) {
			e.preventDefault()
			void load(true)
		}

		return (
			<>
				<div className="page-head">
					<h1>Runs</h1>
					<p className="hint">Deploy history, newest first. Each run records the env, ref/commit, timestamps, and final exit code.</p>
				</div>

				<form className="filters" onSubmit={applyFilters}>
					<label>
						App
						<select value={app} onChange={(e) => setApp(e.target.value)}>
							<option value="">All apps</option>
							{data.apps.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
						</select>
					</label>
					<label>
						Env
						<input value={env} onChange={(e) => setEnv(e.target.value)} placeholder="any" />
					</label>
					<div className="filter-actions">
						<button type="submit" className="primary" disabled={loading}>Filter</button>
						<button
							type="button"
							onClick={() => {
								setApp('')
								setEnv('')
								setRuns(data.initialRuns.items)
								setCursor(data.initialRuns.nextCursor)
							}}
							disabled={loading}
						>
							Reset
						</button>
					</div>
				</form>

				{error && <p className="error-text" role="alert">{error}</p>}

				<Table
					colSpan={7}
					isEmpty={runs.length === 0}
					empty="No runs match."
					head={
						<tr>
							<th>Status</th>
							<th>App</th>
							<th>Env</th>
							<th>Ref</th>
							<th>Commit</th>
							<th>Trigger</th>
							<th>Created</th>
						</tr>
					}
				>
					{runs.map((run) => (
						<tr key={run.id}>
							<td>
								<Link to="runs/detail" params={{ id: run.id }}>
									<RunStatusBadge status={run.status} />
								</Link>
							</td>
							<td>
								<Link to="apps/detail" params={{ id: run.appId }}>{run.appId}</Link>
							</td>
							<td>{run.env}</td>
							<td>
								<code>{shortRef(run.ref)}</code>
							</td>
							<td>
								<code>{shortSha(run.commitSha)}</code>
							</td>
							<td>{run.trigger}</td>
							<td>{fmtDate(run.createdAt)}</td>
						</tr>
					))}
				</Table>

				{cursor !== null && (
					<div className="pager">
						<button type="button" onClick={() => load(false)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>
					</div>
				)}
			</>
		)
	})
