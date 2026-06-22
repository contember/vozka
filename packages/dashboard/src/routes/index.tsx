import { createPage, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { type AccountDto, api, ApiError, type ListResponse, type RegisterAppRequest, type RegisterAppResponse } from '../lib/api'

// Onboarding — the headline UX. "Paste a GitHub repo URL + domain, pick an env + account" creates the
// app and its first env in one `register-app` call. The account must already exist (link to Accounts).

export default createPage()
	.loader(async () => {
		const accounts = await api.get<ListResponse<AccountDto>>('/accounts')
		return { accounts: accounts.items }
	})
	.route('/')
	.render(({ data, invalidate }) => {
		const navigate = useNavigate()
		const accounts = data.accounts

		const [id, setId] = useState('')
		const [repoUrl, setRepoUrl] = useState('')
		const [env, setEnv] = useState('prod')
		const [account, setAccount] = useState(accounts[0]?.name ?? '')
		const [domain, setDomain] = useState('')
		const [triggerRef, setTriggerRef] = useState('')
		const [propustkaUrl, setPropustkaUrl] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function submit(e: React.FormEvent) {
			e.preventDefault()
			setError(null)
			if (accounts.length === 0) {
				setError('Add a Cloudflare account first — every app env deploys to one.')
				return
			}
			const body: RegisterAppRequest = {
				id: id.trim(),
				repoUrl: repoUrl.trim(),
				env: env.trim(),
				account,
				...(domain.trim() === '' ? {} : { domain: domain.trim() }),
				...(triggerRef.trim() === '' ? {} : { triggerRef: triggerRef.trim() }),
				...(propustkaUrl.trim() === '' ? {} : { propustkaUrl: propustkaUrl.trim() }),
			}
			setBusy(true)
			try {
				const result = await api.post<RegisterAppResponse>('/register-app', body)
				invalidate()
				navigate('apps/detail', { params: { id: result.app.id } })
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Onboarding failed.')
			} finally {
				setBusy(false)
			}
		}

		return (
			<>
				<div className="page-head">
					<h1>Onboard an app</h1>
					<p className="hint">
						Register a GitHub repo as a deployable app and create its first environment. Push to the trigger ref (or hit Deploy) and vozka clones, builds,
						and deploys it to the chosen Cloudflare account.
					</p>
				</div>

				{accounts.length === 0 && (
					<div className="panel warn-text" role="alert">
						No Cloudflare accounts yet. <a href="/accounts">Add an account</a> before onboarding an app — each environment deploys to one.
					</div>
				)}

				<form className="panel form" onSubmit={submit}>
					<label>
						App id
						<input
							required
							value={id}
							onChange={(e) => setId(e.target.value)}
							placeholder="acme-storefront"
							autoComplete="off"
						/>
						<span className="hint">Stable identifier for this app across environments. Lowercase, no spaces.</span>
					</label>
					<label>
						GitHub repo URL
						<input
							required
							value={repoUrl}
							onChange={(e) => setRepoUrl(e.target.value)}
							placeholder="https://github.com/acme/storefront"
							autoComplete="off"
						/>
						<span className="hint">Normalized server-side so webhook pushes match. The GitHub App must be installed on it.</span>
					</label>
					<div className="form-row">
						<label>
							Environment
							<input
								required
								value={env}
								onChange={(e) => setEnv(e.target.value)}
								placeholder="prod"
								autoComplete="off"
							/>
						</label>
						<label>
							Cloudflare account
							<select value={account} onChange={(e) => setAccount(e.target.value)} disabled={accounts.length === 0}>
								{accounts.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
							</select>
						</label>
					</div>
					<label>
						Domain (optional)
						<input
							value={domain}
							onChange={(e) => setDomain(e.target.value)}
							placeholder="store.acme.com"
							autoComplete="off"
						/>
						<span className="hint">
							Public domain for this environment, passed to the deploy as <code>VOZKA_DOMAIN</code>.
						</span>
					</label>
					<label>
						Trigger ref (optional)
						<input
							value={triggerRef}
							onChange={(e) => setTriggerRef(e.target.value)}
							placeholder="refs/heads/main"
							autoComplete="off"
						/>
						<span className="hint">Push to this git ref auto-deploys this env. Leave empty for manual-only (Deploy button).</span>
					</label>
					<label>
						propustka URL (optional)
						<input
							value={propustkaUrl}
							onChange={(e) => setPropustkaUrl(e.target.value)}
							placeholder="https://iam.acme.com"
							autoComplete="off"
						/>
					</label>
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy || accounts.length === 0}>
							{busy ? 'Onboarding…' : 'Register app'}
						</button>
					</div>
				</form>
			</>
		)
	})
