/**
 * Order status state machine — server-enforced transitions.
 */

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
  'PAYMENT_FAILED',
  'PAYMENT_EXPIRED',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
]

/** Allowed next statuses from each state. */
export const ORDER_TRANSITIONS = {
  PENDING_PAYMENT: ['PAYMENT_PROCESSING', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED', 'CANCELLED'],
  PAYMENT_PROCESSING: ['CONFIRMED', 'PAYMENT_FAILED', 'PENDING_PAYMENT'],
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'CANCELLED', 'PAYMENT_EXPIRED'],
  PAYMENT_EXPIRED: ['CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED', 'REFUND_PENDING'],
  PROCESSING: ['PACKED', 'CANCELLED', 'REFUND_PENDING'],
  PACKED: ['SHIPPED', 'CANCELLED', 'REFUND_PENDING'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'REFUND_PENDING'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'REFUND_PENDING'],
  DELIVERED: ['REFUND_PENDING'],
  CANCELLED: [],
  REFUND_PENDING: ['REFUNDED', 'CONFIRMED', 'PROCESSING'],
  REFUNDED: [],
}

export function canTransition(from, to) {
  const allowed = ORDER_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/** Fulfilment statuses an admin sets by hand; payment and refund states have their own flows. */
export const ADMIN_SETTABLE_STATUSES = [
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
]

/** Fulfilment stages in order; admins may jump forward, and every step between is recorded. */
const FULFILMENT_FLOW = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']

/**
 * Statuses to apply, in order, to move `from` → `to`, or null if not allowed.
 * Forward jumps fill in the steps between (never "Out for delivery" unless it is the target).
 */
export function adminStatusPath(from, to) {
  if (canTransition(from, to)) return [to]
  const i = FULFILMENT_FLOW.indexOf(from)
  const j = FULFILMENT_FLOW.indexOf(to)
  if (i === -1 || j <= i) return null
  const path = FULFILMENT_FLOW.slice(i + 1, j + 1).filter(
    (s) => s === to || s !== 'OUT_FOR_DELIVERY',
  )
  let prev = from
  for (const s of path) {
    if (!canTransition(prev, s)) return null
    prev = s
  }
  return path
}

function currentStatus(order) {
  const raw = String(order?.status || '')
  return ORDER_TRANSITIONS[raw]
    ? raw
    : mapLegacyStatus(raw, order?.paymentStatus || order?.payment?.status)
}

export function adminNextStatuses(order) {
  const current = currentStatus(order)
  return ADMIN_SETTABLE_STATUSES.filter((s) => adminStatusPath(current, s))
}

/** Map legacy statuses from pre-prepaid orders. */
export function mapLegacyStatus(legacyStatus, paymentStatus) {
  const s = String(legacyStatus || '').toLowerCase()
  const p = String(paymentStatus || '').toLowerCase()
  if (s === 'cancelled') return 'CANCELLED'
  if (s === 'delivered') return 'DELIVERED'
  if (s === 'shipped') return 'SHIPPED'
  if (s === 'packed') return 'PACKED'
  if (s === 'confirmed') return 'CONFIRMED'
  if (p === 'paid') return 'CONFIRMED'
  if (p === 'failed') return 'PAYMENT_FAILED'
  if (p === 'refunded') return 'REFUNDED'
  if (s === 'new' || p === 'pending' || p === 'not_required') return 'PENDING_PAYMENT'
  return 'PENDING_PAYMENT'
}
