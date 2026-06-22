import { createPage } from '@buzola/router'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Table } from '../../components/Table'
import {
	type AccountDto,
	api,
	ApiError,
	type CreateAccountRequest,
	type ListResponse,
	type SetSecretValueRequest,
	type UpdateAccountRequest,
} from '../../lib/api'
import { fmtDate } from '../../lib/format'

// Accounts — the Cloudflare accounts an app env deploys to. Each carries a CF account id and a
// REFERENCE to the API token in the vault. The token VALUE is never requested or shown — only its ref.

export default createPage()
	.loader(async () => {
		const accounts = await api.get<ListResponse<AccountDto>>('/accounts')
		return { accounts: accounts.items }
	})
	.route('/accounts')
	.render(({ data, invalidate }) => (
		<>
			<div className="page-head">
				<h1>Accounts</h1>
				<p className="hint">
					Cloudflare accounts a deploy targets. The API token is stored as a vault <strong>reference</strong>{' '}
					(<code>cfApiTokenRef</code>) — the token value never passes through this dashboard.
				</p>
			</div>

			<AddAccountForm onDone={invalidate} />

			<Table
				colSpan={5}
				isEmpty={data.accounts.length === 0}
				empty="No accounts yet. Add one above."
				head={
					<tr>
						<th>Name</th>
						<th>CF account id</th>
						<th>API token ref</th>
						<th>Created</th>
						<th />
					</tr>
				}
			>
				{data.accounts.map((account) => <AccountRow key={account.name} account={account} onDone={invalidate} />)}
			</Table>
		</>
	))

function AccountRow({ account, onDone }: { account: AccountDto; onDone: () => void }) {
	const [editing, setEditing] = useState(false)
	const [confirming, setConfirming] = useState(false)
	const [settingValue, setSettingValue] = useState(false)
	/** The token value lives in the vault when the ref has the `vault:` prefix; PATCH rotates in place. */
	const inVault = account.cfApiTokenRef.startsWith('vault:')

	async function remove() {
		await api.del(`/accounts/${account.name}`)
		onDone()
	}

	if (editing) {
		return (
			<EditAccountRow
				account={account}
				onDone={() => {
					setEditing(false)
					onDone()
				}}
				onCancel={() => setEditing(false)}
			/>
		)
	}

	if (settingValue) {
		return (
			<SetTokenValueRow
				account={account}
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
				<strong>{account.name}</strong>
			</td>
			<td>
				<code>{account.cfAccountId}</code>
			</td>
			<td>
				<code>{account.cfApiTokenRef}</code>
			</td>
			<td>{fmtDate(account.createdAt)}</td>
			<td className="row-actions">
				<button type="button" className="small" onClick={() => setEditing(true)}>Edit</button>
				<button type="button" className="small" onClick={() => setSettingValue(true)}>{inVault ? 'Rotate token' : 'Set token value'}</button>
				<button type="button" className="danger small" onClick={() => setConfirming(true)}>Delete</button>
				{confirming && (
					<ConfirmDialog
						title="Delete account"
						confirmLabel="Delete"
						body={
							<p>
								Delete account <strong>{account.name}</strong>? App environments bound to it will fail to deploy.
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

function EditAccountRow({ account, onDone, onCancel }: { account: AccountDto; onDone: () => void; onCancel: () => void }) {
	const [cfAccountId, setCfAccountId] = useState(account.cfAccountId)
	const [cfApiTokenRef, setCfApiTokenRef] = useState(account.cfApiTokenRef)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save() {
		setBusy(true)
		setError(null)
		try {
			const body: UpdateAccountRequest = { cfAccountId: cfAccountId.trim(), cfApiTokenRef: cfApiTokenRef.trim() }
			await api.patch(`/accounts/${account.name}`, body)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Update failed.')
			setBusy(false)
		}
	}

	return (
		<tr>
			<td>
				<strong>{account.name}</strong>
			</td>
			<td>
				<input aria-label="CF account id" value={cfAccountId} onChange={(e) => setCfAccountId(e.target.value)} />
			</td>
			<td>
				<input aria-label="API token ref" value={cfApiTokenRef} onChange={(e) => setCfApiTokenRef(e.target.value)} />
				{error && <div className="error-text small">{error}</div>}
			</td>
			<td>{fmtDate(account.createdAt)}</td>
			<td className="row-actions">
				<button type="button" className="primary small" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
				<button type="button" className="small" onClick={onCancel} disabled={busy}>Cancel</button>
			</td>
		</tr>
	)
}

/**
 * Inline write-only setter for an account's CF API token VALUE. PUT (set) stores a fresh vault entry
 * and writes the `vault:<id>` ref back; PATCH (rotate) re-encrypts the existing entry. The value is
 * sent once and never read back — the field is cleared on success.
 */
function SetTokenValueRow({ account, rotate, onDone, onCancel }: { account: AccountDto; rotate: boolean; onDone: () => void; onCancel: () => void }) {
	const [value, setValue] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save() {
		setBusy(true)
		setError(null)
		try {
			const body: SetSecretValueRequest = { value }
			// PUT sets a new vault entry; PATCH rotates the value behind the existing vault ref.
			await (rotate ? api.patch(`/accounts/${account.name}/token`, body) : api.put(`/accounts/${account.name}/token`, body))
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
				<strong>{account.name}</strong>
			</td>
			<td colSpan={2}>
				<input
					type="password"
					aria-label="CF API token value"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder={rotate ? 'New token value' : 'Paste the CF API token'}
					autoComplete="off"
				/>
				<span className="hint">Stored encrypted in the vault. The value is never shown again.</span>
				{error && <div className="error-text small">{error}</div>}
			</td>
			<td>{fmtDate(account.createdAt)}</td>
			<td className="row-actions">
				<button type="button" className="primary small" onClick={save} disabled={busy || value === ''}>
					{busy ? 'Saving…' : rotate ? 'Rotate' : 'Set'}
				</button>
				<button type="button" className="small" onClick={onCancel} disabled={busy}>Cancel</button>
			</td>
		</tr>
	)
}

function AddAccountForm({ onDone }: { onDone: () => void }) {
	const [open, setOpen] = useState(false)
	const [name, setName] = useState('')
	const [cfAccountId, setCfAccountId] = useState('')
	const [cfApiTokenRef, setCfApiTokenRef] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		setBusy(true)
		try {
			const body: CreateAccountRequest = {
				name: name.trim(),
				cfAccountId: cfAccountId.trim(),
				cfApiTokenRef: cfApiTokenRef.trim(),
			}
			await api.post('/accounts', body)
			setName('')
			setCfAccountId('')
			setCfApiTokenRef('')
			setOpen(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Create failed.')
		} finally {
			setBusy(false)
		}
	}

	if (!open) {
		return (
			<div className="panel">
				<button type="button" className="primary" onClick={() => setOpen(true)}>Add account</button>
			</div>
		)
	}

	return (
		<form className="panel form" onSubmit={submit}>
			<h2>Add account</h2>
			<label>
				Name
				<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="acme-prod" autoComplete="off" />
			</label>
			<label>
				Cloudflare account id
				<input required value={cfAccountId} onChange={(e) => setCfAccountId(e.target.value)} placeholder="023e105f4ecef8ad…" autoComplete="off" />
			</label>
			<label>
				API token ref
				<input required value={cfApiTokenRef} onChange={(e) => setCfApiTokenRef(e.target.value)} placeholder="env:ACME_CF_TOKEN" autoComplete="off" />
				<span className="hint">
					A vault reference, not the token itself (e.g. <code>env:ACME_CF_TOKEN</code>). The value never enters this UI.
				</span>
			</label>
			{error && <p className="error-text" role="alert">{error}</p>}
			<div className="form-actions">
				<button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
				<button type="submit" className="primary" disabled={busy}>{busy ? 'Adding…' : 'Add account'}</button>
			</div>
		</form>
	)
}
