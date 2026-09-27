import crypto from 'crypto'

/** Opaque guest tracking token (return once; store only the hash). */
export function generateTrackingToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

/** Crockford base32 — no I, L, O, U so codes survive being read aloud or retyped. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 12

/**
 * Human-typeable tracking code, e.g. 7K3M-Q9XD-2TRA (60 bits, CSPRNG).
 * 32 symbols divide 256 evenly, so `byte & 31` is unbiased.
 */
export function generateTrackingCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] & 31]
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`
}

/** Canonical form for hashing: uppercase, separators removed, ambiguous glyphs folded. */
export function normalizeTrackingCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
