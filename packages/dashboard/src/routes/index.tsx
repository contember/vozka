import { createPage, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { api, ApiError, type RegisterAppRequest, type RegisterAppResponse } from '../lib/api'

// Onboarding — the headline UX. "Paste a GitHub repo URL + domain, pick an env" creates the app and
// its first env in one `register-app` call. The deploy target is vozka's own Cloudflare account
// (single-account — propustka + vozka + the apps all live on it).

export default createPage()
	.route('/')
	.render(() => {
		const navigate = useNavigate()

		const [id, setId] = useState('')
		const [repoUrl, setRepoUrl] = useState('')
		const [env, setEnv] = useState('prod')
		const [domain, setDomain] = useState('')
		const [triggerRef, setTriggerRef] = useState('')
		const [busy, setBusy] = useState(false)
		const [error, setError] = useState<string | null>(null)

		async function submit(e: React.FormEvent) {
			e.preventDefault()
			setError(null)
			const body: RegisterAppRequest = {
				id: id.trim(),
				repoUrl: repoUrl.trim(),
				env: env.trim(),
				...(domain.trim() === '' ? {} : { domain: domain.trim() }),
				...(triggerRef.trim() === '' ? {} : { triggerRef: triggerRef.trim() }),
			}
			setBusy(true)
			try {
				const result = await api.post<RegisterAppResponse>('/register-app', body)
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
						and deploys it to its Cloudflare account.
					</p>
				</div>

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
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy}>
							{busy ? 'Onboarding…' : 'Register app'}
						</button>
					</div>
				</form>
			</>
		)
	})
