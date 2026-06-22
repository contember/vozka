// The real `Spawner`: runs a child via Bun, decoding stdout/stderr and streaming each chunk to the
// caller as it arrives. No shell — argv is passed verbatim — so nothing the job carries can be
// interpreted as a shell metacharacter. The child's env is the runner's env plus the spec's extras
// (creds + secret values for the `vozka` child).

import type { Spawner, SpawnHandlers, SpawnResult, SpawnSpec } from './runner'

/** Pump a readable byte stream, decoding to text and handing each chunk to `onChunk`. */
const pump = async (stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<void> => {
	const decoder = new TextDecoder()
	const reader = stream.getReader()
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		if (value !== undefined) {
			onChunk(decoder.decode(value, { stream: true }))
		}
	}
	const tail = decoder.decode()
	if (tail.length > 0) {
		onChunk(tail)
	}
}

/** Default spawner: a real Bun child process with piped, streamed stdout/stderr. */
export const bunSpawner: Spawner = async (spec: SpawnSpec, handlers: SpawnHandlers): Promise<SpawnResult> => {
	const proc = Bun.spawn([spec.command, ...spec.args], {
		cwd: spec.cwd,
		env: { ...process.env, ...spec.env },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [, , exitCode] = await Promise.all([
		pump(proc.stdout, handlers.onStdout),
		pump(proc.stderr, handlers.onStderr),
		proc.exited,
	])
	return { exitCode }
}
