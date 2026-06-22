import { Link, Outlet, useRoute } from '@buzola/router'
import { RouteError } from '../components/RouteError'

type Page = 'index' | 'apps' | 'runs' | 'accounts'

interface NavItem {
	to: Page
	label: string
	/** Path prefix used to mark the item (and its section) active. */
	match: string
}

const NAV: NavItem[] = [
	{ to: 'index', label: 'Onboarding', match: '/' },
	{ to: 'apps', label: 'Apps', match: '/apps' },
	{ to: 'runs', label: 'Runs', match: '/runs' },
	{ to: 'accounts', label: 'Accounts', match: '/accounts' },
]

export default function RootLayout() {
	const { pathname } = useRoute()

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="brand">
					<span className="brand-name">vozka</span>
					<span className="brand-sub">deploy control plane</span>
				</div>
				<nav>
					{NAV.map((item) => {
						const active = item.match === '/'
							? pathname === '/'
							: pathname === item.match || pathname.startsWith(`${item.match}/`)
						return (
							<Link
								key={item.to}
								to={item.to}
								className={`nav-item${active ? ' active' : ''}`}
								aria-current={active ? 'page' : undefined}
							>
								{item.label}
							</Link>
						)
					})}
				</nav>
				<div className="me muted small">
					Authorization is enforced per action by propustka. Forbidden screens show a notice — ask a vozka admin for a grant.
				</div>
			</aside>
			<main className="content">
				<Outlet
					fallback={<div className="loading">Loading…</div>}
					errorFallback={(error) => <RouteError error={error} />}
				/>
			</main>
		</div>
	)
}
