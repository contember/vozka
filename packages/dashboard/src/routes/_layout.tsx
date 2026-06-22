import { Outlet } from '@buzola/router'

export default function RootLayout() {
	return (
		<div className="app-shell">
			<Outlet fallback={<div className="loading">Loading…</div>} />
		</div>
	)
}
