/**
 * UUIDv7 generator — time-ordered ids for `runs` (so `ORDER BY id DESC` is chronological and a
 * keyset cursor works). 48-bit Unix-millis timestamp prefix + 74 random bits, version/variant set
 * per RFC 9562. Self-contained (no dependency on `@propustka/core`) so the control plane owns its
 * own id minting. `crypto.getRandomValues` is available in both Workers and Bun.
 */
export function uuidv7(): string {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)

	const millis = Date.now()
	// 48-bit big-endian timestamp in bytes 0..5.
	bytes[0] = (millis / 2 ** 40) & 0xff
	bytes[1] = (millis / 2 ** 32) & 0xff
	bytes[2] = (millis / 2 ** 24) & 0xff
	bytes[3] = (millis / 2 ** 16) & 0xff
	bytes[4] = (millis / 2 ** 8) & 0xff
	bytes[5] = millis & 0xff

	// Version 7 in the high nibble of byte 6; variant (10xx) in the high bits of byte 8.
	bytes[6] = (bytes[6]! & 0x0f) | 0x70
	bytes[8] = (bytes[8]! & 0x3f) | 0x80

	const hex: string[] = []
	for (const b of bytes) {
		hex.push(b.toString(16).padStart(2, '0'))
	}
	const s = hex.join('')
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
