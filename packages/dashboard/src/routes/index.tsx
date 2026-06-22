import { createPage } from '@buzola/router'

// M0 placeholder home. The real control-plane UI (apps, runs, secrets) lands in M3.
export default createPage()
	.route('/')
	.render(() => (
		<main>
			<h1>vozka</h1>
			<p>Deploy control plane — dashboard skeleton (M0). UI arrives in M3.</p>
		</main>
	))
