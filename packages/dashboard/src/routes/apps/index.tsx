import { createPage, Link } from '@buzola/router'
import { useState } from 'react'
import { Table } from '../../components/Table'
import { api, type AppDto, type ListResponse } from '../../lib/api'
import { fmtDate, shortRef } from '../../lib/format'

// Apps — every registered app. The detail page (apps/:id) holds its envs, secrets, and per-env Deploy.
// New apps are onboarded from the Onboarding screen (the headline flow); this is the registry view.

export default createPage()
	.loader(async () => {
		const apps = await api.get<ListResponse<AppDto>>('/apps')
		return { apps: apps.items }
	})
	.route('/apps')
	.render(({ data }) => {
		const [query, setQuery] = useState('')
		const q = query.trim().toLowerCase()
		const filtered = data.apps.filter((app) => q === '' || app.id.toLowerCase().includes(q) || app.repoUrl.toLowerCase().includes(q))

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<h1>Apps</h1>
						<Link to="index" className="nav-cta">+ Onboard app</Link>
					</div>
				</div>

				<div className="toolbar">
					<input type="search" placeholder="Search id / repo" value={query} onChange={(e) => setQuery(e.target.value)} />
					<span className="count muted">{filtered.length} of {data.apps.length}</span>
				</div>

				<Table
					colSpan={4}
					isEmpty={filtered.length === 0}
					empty={data.apps.length === 0 ? 'No apps registered yet. Onboard one.' : 'No apps match.'}
					head={
						<tr>
							<th>App</th>
							<th>Repo</th>
							<th>Default branch</th>
							<th>Created</th>
						</tr>
					}
				>
					{filtered.map((app) => (
						<tr key={app.id}>
							<td>
								<Link to="apps/detail" params={{ id: app.id }}>
									<strong>{app.id}</strong>
								</Link>
							</td>
							<td>
								<code className="small">{app.repoUrl}</code>
							</td>
							<td>
								<code>{shortRef(`refs/heads/${app.defaultBranch}`)}</code>
							</td>
							<td>{fmtDate(app.createdAt)}</td>
						</tr>
					))}
				</Table>
			</>
		)
	})
