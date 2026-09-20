/**
 * Minimal structured logger — never log secrets/payment credentials.
 */
function line(level, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta && typeof meta === 'object' ? { meta: sanitize(meta) } : {}),
  }
  const out = JSON.stringify(entry)
  if (level === 'error') console.error(out)
  else console.log(out)
}

const BLOCK = /secret|password|authorization|cookie|card|cvv|otp|pin|api[_-]?key/i

function sanitize(obj, depth = 0) {
  if (depth > 4 || obj == null) return obj
  if (Array.isArray(obj)) return obj.map((v) => sanitize(v, depth + 1))
  if (typeof obj !== 'object') return obj
  const next = {}
  for (const [k, v] of Object.entries(obj)) {
    if (BLOCK.test(k)) next[k] = '[redacted]'
    else next[k] = sanitize(v, depth + 1)
  }
  return next
}

export const logger = {
  info: (message, meta) => line('info', message, meta),
  warn: (message, meta) => line('warn', message, meta),
  error: (message, meta) => line('error', message, meta),
}
