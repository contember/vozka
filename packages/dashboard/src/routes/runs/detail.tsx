import { createPage, Link } from '@buzola/router'
import { RunStatusBadge } from '../../components/Badge'
import { LogView } from '../../components/LogView'
import { api, type AppEnvDto, type ListResponse, type RunDto } from '../../lib/api'
import { fmtDate, fmtDuration, shortRef, shortSha } from '../../lib/format'

// Run detail — the run's metadata + the live log view. The LogView tails `runs/:id/tail` while the run
// is non-terminal, then shows the complete log; the final status + exit code come from the run row.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const run = await api.get<RunDto>(`/runs/${params.id}`)
		// The env's deploy target (account/domain) is useful context; tolerate it being gone (deleted env).
		const envs = await api.get<ListResponse<AppEnvDto>>(`/apps/${run.appId}/envs`).catch(() => null)
		const appEnv = envs?.items.find((e) => e.env === run.env) ?? null
		return { run, appEnv }
	})
	.route('/runs/:id')
	.render(({ data }) => {
		const { run, appEnv } = data

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<h1>
							Run <code>{run.id.slice(0, 8)}</code>
						</h1>
						<RunStatusBadge status={run.status} />
					</div>
					<div className="subtitle muted">
						<Link to="apps/detail" params={{ id: run.appId }}>{run.appId}</Link> · {run.env} · {run.trigger}
					</div>
				</div>

				<section>
					<div className="detail-grid">
						<Field label="Ref">
							<code>{shortRef(run.ref)}</code>
						</Field>
						<Field label="Commit">
							<code>{shortSha(run.commitSha)}</code>
						</Field>
						<Field label="Exit code">
							{run.exitCode === null ? <span className="muted">—</span> : <code>{run.exitCode}</code>}
						</Field>
						<Field label="Duration">{fmtDuration(run.startedAt, run.finishedAt)}</Field>
						<Field label="Created">{fmtDate(run.createdAt)}</Field>
						<Field label="Started">{fmtDate(run.startedAt)}</Field>
						<Field label="Finished">{fmtDate(run.finishedAt)}</Field>
						{appEnv !== null && (
							<Field label="Target">
								{appEnv.accountName}
								{appEnv.domain !== null && (
									<>
										· <code>{appEnv.domain}</code>
									</>
								)}
							</Field>
						)}
					</div>
				</section>

				<section>
					<h2>Log</h2>
					<LogView runId={run.id} initialStatus={run.status} />
				</section>
			</>
		)
	})

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<h4>{label}</h4>
			{children}
		</div>
	)
}
