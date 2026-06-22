#!/usr/bin/env bun
// Container entrypoint: start the job-protocol HTTP server on the fixed runner port, backed by the
// real Bun spawner and a workspace dir for clones. This is what the Dockerfile's ENTRYPOINT runs.

import { RUNNER_PORT } from './protocol'
import { createServer } from './server'
import { bunSpawner } from './spawn'

const workspace = process.env['VOZKA_WORKSPACE'] ?? '/workspace'
const port = process.env['PORT'] !== undefined ? Number(process.env['PORT']) : RUNNER_PORT

const server = createServer({ spawn: bunSpawner, workspace })

Bun.serve({
	port,
	// The server engine handles the protocol; map every request through it.
	fetch: (request) => server.handle(request),
	// A long clone+install+deploy must not be cut short by Bun's default request timeout.
	idleTimeout: 255,
})

console.info(`vozka runner listening on :${port} (workspace ${workspace})`)
