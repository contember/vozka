/** JSON response helpers for the control-plane API. Mirrors propustka's `src/admin/http.ts`. */
export function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
	})
}

/** A structured JSON error with an HTTP status. `extra` merges extra fields into the body (e.g. a
 * `loginUrl` on a 401 so the dashboard can bounce the browser to propustka's SSO login). */
export function error(status: number, message: string, extra?: Record<string, unknown>): Response {
	return json({ error: message, ...extra }, { status })
}

/**
 * Parse a JSON request body as `unknown` (undefined on parse failure). Callers narrow fields with the
 * readers in `./json` — no `as` casts on untrusted input.
 */
export async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json()
	} catch {
		return undefined
	}
}
