import crypto from 'crypto'

/**
 * Human-readable order number, e.g. SCN-20260921-8F42K
 * Not sequential — harder to enumerate.
 */
export function generateOrderNumber(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5)
  return `SCN-${y}${m}${d}-${suffix}`
}
