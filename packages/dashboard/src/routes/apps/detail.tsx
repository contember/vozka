import { createPage, Link, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { RunStatusBadge } from '../../components/Badge'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Table } from '../../components/Table'
import {
	api,
	ApiError,
	type AppDto,
	type AppEnvDto,
	type AppSecretDto,
	type CursorList,
	type ListResponse,
	type PutAppEnvRequest,
	type PutAppSecretRequest,
	type RunDto,
	type SetSecretValueRequest,
	type TriggerDeployRequest,
} from '../../lib/api'
import { fmtDate, qs, shortRef, shortSha } from '../../lib/format'

// App detail — the per-app registry + operations view: its meta, its environments (each with a
// Deploy button + edit/delete), its secret references (names + layer + vault ref, values never shown),
// and the most recent runs for this app. Add/edit/delete go through the manage actions on `/api/apps/:id/*`.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [app, envs, secrets, runs] = await Promise.all([
			api.get<AppDto>(`/apps/${params.id}`),
			api.get<ListResponse<AppEnvDto>>(`/apps/${params.id}/envs`),
			api.get<ListResponse<AppSecretDto>>(`/apps/${params.id}/secrets`),
			api.get<CursorList<RunDto>>(`/runs${qs({ app: params.id, limit: 10 })}`),
		])
		return { app, envs: envs.items, secrets: secrets.items, runs: runs.items }
	})
	.route('/apps/:id')
	.render(({ data, invalidate }) => {
		const { app, envs, secrets, runs } = data
		const [confirming, setConfirming] = useState(false)
		const navigate = useNavigate()

		async function deleteApp() {
			await api.del(`/apps/${app.id}`)
			navigate('apps')
		}

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<h1>{app.id}</h1>
						<button type="button" className="danger" onClick={() => setConfirming(true)}>Delete app</button>
					</div>
					<div className="subtitle muted">
						<code>{app.repoUrl}</code> · default branch <code>{app.defaultBranch}</code> · created {fmtDate(app.createdAt)}
					</div>
					{confirming && (
						<ConfirmDialog
							title="Delete app"
							confirmLabel="Delete"
							body={
								<p>
									Delete app <strong>{app.id}</strong> and all its environments and secrets? Run history is kept.
								</p>
							}
							onConfirm={deleteApp}
							onClose={() => setConfirming(false)}
						/>
					)}
				</div>

				<section>
					<h2>Build config</h2>
					<div className="detail-grid">
						<Field label="Worker dir" value={app.workerDir} mono />
						<Field label="Config path" value={app.configPath} mono />
						<Field label="Build command" value={app.buildCmd} mono />
						<Field label="GitHub installation id" value={app.githubInstallationId === null ? null : String(app.githubInstallationId)} mono />
					</div>
				</section>

				<section>
					<div className="page-head-row">
						<h2>Environments</h2>
					</div>
					<Table
						colSpan={4}
						isEmpty={envs.length === 0}
						empty="No environments. Add one below."
						head={
							<tr>
								<th>Env</th>
								<th>Domain</th>
								<th>Trigger ref</th>
								<th />
							</tr>
						}
					>
						{envs.map((env) => <EnvRow key={env.env} appId={app.id} env={env} onDone={invalidate} />)}
					</Table>
					<AddEnvForm appId={app.id} existing={envs} onDone={invalidate} />
				</section>

				<section>
					<h2>Secrets</h2>
					<p className="hint">
						Secret <strong>references</strong> deployed with this app. The <code>*</code>{' '}
						layer applies to every env; an env-specific entry overrides it. Values live in the vault — only names and refs are shown.
					</p>
					<Table
						colSpan={4}
						isEmpty={secrets.length === 0}
						empty="No secrets. Add one below."
						head={
							<tr>
								<th>Name</th>
								<th>Layer</th>
								<th>Value ref</th>
								<th />
							</tr>
						}
					>
						{secrets.map((secret) => <SecretRow key={`${secret.env ?? '*'}/${secret.name}`} appId={app.id} secret={secret} onDone={invalidate} />)}
					</Table>
					<AddSecretForm appId={app.id} envs={envs} onDone={invalidate} />
				</section>

				<section>
					<div className="page-head-row">
						<h2>Recent runs</h2>
						<Link to="runs" className="nav-cta">All runs →</Link>
					</div>
					<Table
						colSpan={5}
						isEmpty={runs.length === 0}
						empty="No runs for this app yet."
						head={
							<tr>
								<th>Status</th>
								<th>Env</th>
								<th>Ref</th>
								<th>Commit</th>
								<th>Started</th>
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
								<td>{run.env}</td>
								<td>
									<code>{shortRef(run.ref)}</code>
								</td>
								<td>
									<code>{shortSha(run.commitSha)}</code>
								</td>
								<td>{fmtDate(run.createdAt)}</td>
							</tr>
						))}
					</Table>
				</section>
			</>
		)
	})

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
	return (
		<div>
			<h4>{label}</h4>
			{value === null ? <span className="muted">—</span> : mono ? <code>{value}</code> : value}
		</div>
	)
}

function DeployButton({ appId, env }: { appId: string; env: AppEnvDto }) {
	const navigate = useNavigate()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function deploy() {
		setBusy(true)
		setError(null)
		try {
			const body: TriggerDeployRequest = { appId, env: env.env }
			const run = await api.post<RunDto>('/deploy', body)
			navigate('runs/detail', { params: { id: run.id } })
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Deploy failed.')
			setBusy(false)
		}
	}

	return (
		<>
			<button type="button" className="primary small" onClick={deploy} disabled={busy}>{busy ? 'Deploying…' : 'Deploy'}</button>
			{error && <div className="error-text small">{error}</div>}
		</>
	)
}

function EnvRow({ appId, env, onDone }: { appId: string; env: AppEnvDto; onDone: () => void }) {
	const [editing, setEditing] = useState(false)
	const [confirming, setConfirming] = useState(false)

	async function remove() {
		await api.del(`/apps/${appId}/envs/${env.env}`)
		onDone()
	}

	if (editing) {
		return (
			<EnvForm
				appId={appId}
				env={env.env}
				initial={env}
				onDone={() => {
					setEditing(false)
					onDone()
				}}
				onCancel={() => setEditing(false)}
			/>
		)
	}

	return (
		<tr>
			<td>
				<strong>{env.env}</strong>
			</td>
			<td>{env.domain === null ? <span className="muted">—</span> : env.domain}</td>
			<td>{env.triggerRef === null ? <span className="muted">manual-only</span> : <code>{shortRef(env.triggerRef)}</code>}</td>
			<td className="row-actions">
				<DeployButton appId={appId} env={env} />
				<button type="button" className="small" onClick={() => setEditing(true)}>Edit</button>
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Delete</button>
				{confirming && (
					<ConfirmDialog
						title="Delete environment"
						confirmLabel="Delete"
						body={
							<p>
								Delete environment <strong>{env.env}</strong> of <strong>{appId}</strong>?
							</p>
						}
						onConfirm={remove}
						onClose={() => setConfirming(false)}
					/>
				)}
			</td>
		</tr>
	)
}

/** Shared env editor — an inline table row form for both edit and add. */
function EnvForm(
	{ appId, env, initial, onDone, onCancel, lockEnv = true }: {
		appId: string
		env: string
		initial: AppEnvDto | null
		onDone: () => void
		onCancel: () => void
		lockEnv?: boolean
	},
) {
	const [envName, setEnvName] = useState(env)
	const [domain, setDomain] = useState(initial?.domain ?? '')
	const [triggerRef, setTriggerRef] = useState(initial?.triggerRef ?? '')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save() {
		setBusy(true)
		setError(null)
		try {
			const body: PutAppEnvRequest = {
				domain: domain.trim() === '' ? null : domain.trim(),
				triggerRef: triggerRef.trim() === '' ? null : triggerRef.trim(),
			}
			await api.put(`/apps/${appId}/envs/${envName.trim()}`, body)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<tr>
			<td>
				{lockEnv
					? <strong>{envName}</strong>
					: <input aria-label="Env" value={envName} onChange={(e) => setEnvName(e.target.value)} placeholder="stage" />}
			</td>
			<td>
				<input aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="store.acme.com" />
			</td>
			<td>
				<input aria-label="Trigger ref" value={triggerRef} onChange={(e) => setTriggerRef(e.target.value)} placeholder="refs/heads/main" />
				{error && <div className="error-text small">{error}</div>}
			</td>
			<td className="row-actions">
				<button type="button" className="primary small" onClick={save} disabled={busy || envName.trim() === ''}>
					{busy ? 'Saving…' : 'Save'}
				</button>
				<button type="button" className="small" onClick={onCancel} disabled={busy}>Cancel</button>
			</td>
		</tr>
	)
}

function AddEnvForm({ appId, existing, onDone }: { appId: string; existing: AppEnvDto[]; onDone: () => void }) {
	const [open, setOpen] = useState(false)

	if (!open) {
		return (
			<div className="add-row">
				<button type="button" className="small" onClick={() => setOpen(true)}>+ Add environment</button>
			</div>
		)
	}

	return (
		<div className="table-wrap inline-add">
			<table>
				<tbody>
					<EnvForm
						appId={appId}
						env={existing.length === 0 ? 'prod' : ''}
						initial={null}
						lockEnv={false}
						onDone={() => {
							setOpen(false)
							onDone()
						}}
						onCancel={() => setOpen(false)}
					/>
				</tbody>
			</table>
		</div>
	)
}

function SecretRow({ appId, secret, onDone }: { appId: string; secret: AppSecretDto; onDone: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const [settingValue, setSettingValue] = useState(false)
	/** The value lives in the vault when the ref has the `vault:` prefix; PATCH rotates it in place. */
	const inVault = secret.valueRef.startsWith('vault:')

	async function remove() {
		await api.del(`/apps/${appId}/secrets/${secret.name}${qs({ env: secret.env })}`)
		onDone()
	}

	if (settingValue) {
		return (
			<SetSecretValueRow
				appId={appId}
				secret={secret}
				rotate={inVault}
				onDone={() => {
					setSettingValue(false)
					onDone()
				}}
				onCancel={() => setSettingValue(false)}
			/>
		)
	}

	return (
		<tr>
			<td>
				<code>{secret.name}</code>
			</td>
			<td>{secret.env === null ? <span className="muted">* (all envs)</span> : secret.env}</td>
			<td>
				<code>{secret.valueRef}</code>
			</td>
			<td className="row-actions">
				<button type="button" className="small" onClick={() => setSettingValue(true)}>{inVault ? 'Rotate' : 'Set value'}</button>
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Delete</button>
				{confirming && (
					<ConfirmDialog
						title="Delete secret"
						confirmLabel="Delete"
						body={
							<p>
								Delete secret <strong>{secret.name}</strong> ({secret.env ?? 'all envs'})?
							</p>
						}
						onConfirm={remove}
						onClose={() => setConfirming(false)}
					/>
				)}
			</td>
		</tr>
	)
}

/**
 * Inline write-only setter for an app secret's VALUE. PUT (set) stores a fresh vault entry and upserts
 * the `vault:<id>` ref onto the (app, env, name) row; PATCH (rotate) re-encrypts the existing entry.
 * The value is sent once and never read back — the field clears on success. `env` rides the body.
 */
function SetSecretValueRow(
	{ appId, secret, rotate, onDone, onCancel }: { appId: string; secret: AppSecretDto; rotate: boolean; onDone: () => void; onCancel: () => void },
) {
	const [value, setValue] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save() {
		setBusy(true)
		setError(null)
		try {
			const body: SetSecretValueRequest = { value, env: secret.env }
			const path = `/apps/${appId}/secrets/${secret.name}/value`
			// PUT sets a new vault entry; PATCH rotates the value behind the existing vault ref.
			await (rotate ? api.patch(path, body) : api.put(path, body))
			setValue('')
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<tr>
			<td>
				<code>{secret.name}</code>
			</td>
			<td>{secret.env === null ? <span className="muted">* (all envs)</span> : secret.env}</td>
			<td>
				<input
					type="password"
					aria-label="Secret value"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder={rotate ? 'New value' : 'Secret value'}
					autoComplete="off"
				/>
				<span className="hint">Stored encrypted in the vault. Never shown again.</span>
				{error && <div className="error-text small">{error}</div>}
			</td>
			<td className="row-actions">
				<button type="button" className="primary small" onClick={save} disabled={busy || value === ''}>
					{busy ? 'Saving…' : rotate ? 'Rotate' : 'Set'}
				</button>
				<button type="button" className="small" onClick={onCancel} disabled={busy}>Cancel</button>
			</td>
		</tr>
	)
}

function AddSecretForm({ appId, envs, onDone }: { appId: string; envs: AppEnvDto[]; onDone: () => void }) {
	const [open, setOpen] = useState(false)
	const [name, setName] = useState('')
	const [valueRef, setValueRef] = useState('')
	/** '' = the all-env (*) layer; otherwise an env name. */
	const [env, setEnv] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const body: PutAppSecretRequest = {
				name: name.trim(),
				valueRef: valueRef.trim(),
				env: env === '' ? null : env,
			}
			await api.put(`/apps/${appId}/secrets`, body)
			setName('')
			setValueRef('')
			setEnv('')
			setOpen(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
		} finally {
			setBusy(false)
		}
	}

	if (!open) {
		return (
			<div className="add-row">
				<button type="button" className="small" onClick={() => setOpen(true)}>+ Add secret</button>
			</div>
		)
	}

	return (
		<form className="panel form inline" onSubmit={submit}>
			<label>
				Name
				<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="STRIPE_KEY" autoComplete="off" />
			</label>
			<label>
				Layer
				<select value={env} onChange={(e) => setEnv(e.target.value)}>
					<option value="">* (all envs)</option>
					{envs.map((e) => <option key={e.env} value={e.env}>{e.env}</option>)}
				</select>
			</label>
			<label>
				Value ref
				<input required value={valueRef} onChange={(e) => setValueRef(e.target.value)} placeholder="env:STRIPE_KEY" autoComplete="off" />
			</label>
			<div className="filter-actions">
				<button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add secret'}</button>
				<button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
			</div>
			{error && <p className="error-text" role="alert">{error}</p>}
		</form>
	)
}
