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

export function adminNextStatuses(order) {
  const raw = String(order?.status || '')
  const current = ORDER_TRANSITIONS[raw]
    ? raw
    : mapLegacyStatus(raw, order?.paymentStatus || order?.payment?.status)
  return (ORDER_TRANSITIONS[current] || []).filter((s) => ADMIN_SETTABLE_STATUSES.includes(s))
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
