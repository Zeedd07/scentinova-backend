import crypto from 'crypto'

/** Opaque guest tracking token (return once; store only the hash). */
export function generateTrackingToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}
