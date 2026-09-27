/**
 * Public guest order tracking.
 * Access requires order number + a secret (checkout token or emailed tracking code);
 * responses carry only what a tracking page needs — no contact details, street
 * address, payment gateway ids, internal notes, or Mongo internals.
 */
import { Order } from '../models/Order.js'
import { ApiError } from '../utils/ApiError.js'
import { env } from '../config/env.js'
import { mapLegacyStatus } from '../utils/orderStatus.js'
import {
  generateTrackingCode,
  hashToken,
  normalizeTrackingCode,
  safeEqualHex,
} from '../utils/tokens.js'

const MAX_TRACKING_CODES = 5
const TRACKING_CODE_LENGTH = 12
/** Checkout tokens are 43-char base64url; anything shorter is never a full token. */
const MIN_FULL_TOKEN_LENGTH = 32

export const TRACKING_NOT_FOUND_MESSAGE =
  "We couldn't find an order with that number. Please check your order ID and try again."

function notFound() {
  return new ApiError(404, 'ORDER_NOT_FOUND', TRACKING_NOT_FOUND_MESSAGE)
}

/** True when `token` is this order's checkout token or one of its emailed codes. */
export function tokenMatchesOrder(order, token) {
  const raw = String(token || '').trim()
  if (!order || !raw) return false

  if (order.trackingTokenHash && safeEqualHex(hashToken(raw), order.trackingTokenHash)) {
    return true
  }

  const code = normalizeTrackingCode(raw)
  if (code.length !== TRACKING_CODE_LENGTH) return false
  const codeHash = hashToken(code)
  return (order.trackingCodeHashes || []).some((h) => safeEqualHex(codeHash, h))
}

export async function trackPublicOrder({ orderNumber, token }) {
  const number = String(orderNumber || '').trim().toUpperCase()
  if (!number) throw notFound()
  const order = await Order.findOne({ orderNumber: number })
  if (!tokenMatchesOrder(order, token)) throw notFound()
  return toPublicTracking(order)
}

/** Legacy links (/track-order?token=…) carry only the 256-bit checkout token. */
export async function trackPublicOrderByToken(token) {
  const raw = String(token || '').trim()
  if (raw.length < MIN_FULL_TOKEN_LENGTH) throw notFound()
  const order = await Order.findOne({ trackingTokenHash: hashToken(raw) })
  if (!order) throw notFound()
  return toPublicTracking(order)
}

/**
 * Tracking code for the confirmation email. The raw code is held only until the
 * email is accepted (then cleared) so retries send an identical payload under the
 * same Resend idempotency key; long-term only the hash remains.
 */
export async function issueEmailTrackingCode(order) {
  if (order.pendingEmailTrackingCode) return order.pendingEmailTrackingCode
  const code = generateTrackingCode()
  await Order.updateOne(
    { _id: order._id },
    {
      $set: { pendingEmailTrackingCode: code },
      $push: {
        trackingCodeHashes: {
          $each: [hashToken(normalizeTrackingCode(code))],
          $slice: -MAX_TRACKING_CODES,
        },
      },
    },
  )
  return code
}

function publicSiteUrl() {
  const first = String(env.clientUrl || '')
    .split(',')
    .map((s) => s.trim())
    .find(Boolean)
  return (first || 'http://localhost:5173').replace(/\/+$/, '')
}

export function buildTrackingUrl(orderNumber, token) {
  const params = new URLSearchParams({ order: orderNumber, token })
  return `${publicSiteUrl()}/track-order?${params.toString()}`
}

const STATUS_LABELS = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAYMENT_PROCESSING: 'Payment processing',
  PAYMENT_FAILED: 'Payment failed',
  PAYMENT_EXPIRED: 'Payment expired',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUND_PENDING: 'Refund in progress',
  REFUNDED: 'Refunded',
}

/** Index into the customer timeline for each progress status. */
const STAGE_OF_STATUS = {
  PENDING_PAYMENT: 0,
  PAYMENT_PROCESSING: 0,
  PAYMENT_FAILED: 0,
  PAYMENT_EXPIRED: 0,
  CONFIRMED: 1,
  PROCESSING: 2,
  PACKED: 2,
  SHIPPED: 3,
  OUT_FOR_DELIVERY: 4,
  DELIVERED: 5,
}

const TERMINAL_STATUSES = new Set(['CANCELLED', 'REFUND_PENDING', 'REFUNDED'])
const PAYMENT_ISSUE_STATUSES = new Set(['PAYMENT_FAILED', 'PAYMENT_EXPIRED'])

function canonicalStatus(o) {
  const s = String(o.status || '')
  if (STATUS_LABELS[s]) return s
  return mapLegacyStatus(s, o.paymentStatus || o.payment?.status)
}

function publicPaymentStatus(o) {
  const raw = String(o.paymentStatus || o.payment?.status || '').toUpperCase()
  if (raw === 'PAID' || raw === 'CAPTURED') return 'PAID'
  if (raw === 'REFUNDED' || raw === 'PARTIALLY_REFUNDED' || raw === 'FAILED') return raw
  return 'PENDING'
}

function paymentStatusLabel(paymentStatus, isCod) {
  switch (paymentStatus) {
    case 'PAID':
      return 'Paid'
    case 'FAILED':
      return 'Payment failed'
    case 'REFUNDED':
      return 'Refunded'
    case 'PARTIALLY_REFUNDED':
      return 'Partially refunded'
    default:
      return isCod ? 'Pay on delivery' : 'Awaiting payment'
  }
}

function safeHttpUrl(value) {
  if (!value) return null
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function firstHistoryAt(history, statuses) {
  const hit = history.find((h) => statuses.includes(h.status))
  return hit?.createdAt || null
}

function buildTimeline(o, status, isCod) {
  const history = Array.isArray(o.statusHistory) ? o.statusHistory : []
  const terminal = TERMINAL_STATUSES.has(status)

  let stage = STAGE_OF_STATUS[status]
  if (terminal) {
    stage = history.reduce((max, h) => {
      const s = STAGE_OF_STATUS[h.status]
      return s != null && s > max ? s : max
    }, 0)
  }
  if (stage == null) stage = 0

  const steps = [
    { key: 'PLACED', label: 'Order placed', at: o.createdAt || null },
    {
      key: 'CONFIRMED',
      label: isCod ? 'Order confirmed' : 'Payment confirmed',
      at:
        (isCod ? null : o.payment?.capturedAt) ||
        firstHistoryAt(history, ['CONFIRMED']),
    },
    {
      key: 'PROCESSING',
      label: status === 'PACKED' ? 'Packed' : 'Processing',
      at: firstHistoryAt(history, ['PROCESSING', 'PACKED']),
    },
    {
      key: 'SHIPPED',
      label: 'Shipped',
      at: o.fulfillment?.shippedAt || firstHistoryAt(history, ['SHIPPED']),
    },
    {
      key: 'OUT_FOR_DELIVERY',
      label: 'Out for delivery',
      at: firstHistoryAt(history, ['OUT_FOR_DELIVERY']),
    },
    {
      key: 'DELIVERED',
      label: 'Delivered',
      at: o.fulfillment?.deliveredAt || firstHistoryAt(history, ['DELIVERED']),
    },
  ]

  return steps.map((step, i) => {
    let state
    if (i < stage) state = 'complete'
    else if (i === stage) {
      state = terminal || status === 'DELIVERED' ? 'complete' : 'current'
    } else state = terminal ? 'skipped' : 'upcoming'
    return { ...step, at: state === 'complete' || state === 'current' ? step.at : null, state }
  })
}

const UPDATE_HIDDEN_STATUSES = new Set(['PENDING_PAYMENT', 'PAYMENT_PROCESSING'])
const MAX_UPDATES = 20

/** Customer-visible history, newest first: status changes and admin messages only. */
function buildUpdates(o) {
  const history = Array.isArray(o.statusHistory) ? o.statusHistory : []
  const updates = []
  for (const h of history) {
    const message = h.customerMessage ? String(h.customerMessage) : null
    const changed = h.previousStatus !== h.status
    if (!message && (!changed || UPDATE_HIDDEN_STATUSES.has(h.status))) continue
    if (!STATUS_LABELS[h.status]) continue
    updates.push({
      status: h.status,
      label: STATUS_LABELS[h.status],
      at: h.createdAt || null,
      message,
    })
  }
  return updates.reverse().slice(0, MAX_UPDATES)
}

function itemPaise(item) {
  const unit =
    item.unitPricePaise ?? (item.unitPrice != null ? Math.round(item.unitPrice * 100) : 0)
  const total =
    item.totalPaise ??
    (item.lineTotal != null ? Math.round(item.lineTotal * 100) : unit * (item.quantity || 0))
  return { unit, total }
}

export function toPublicTracking(order) {
  const o = order.toObject ? order.toObject() : order
  const isCod = String(o.paymentMethod || '').toUpperCase() === 'COD'
  const status = canonicalStatus(o)
  const paymentStatus = publicPaymentStatus(o)
  const p = o.pricing || {}
  const totalPaise = Number(p.totalPaise ?? Math.round((o.total || 0) * 100))

  const amountDuePaise =
    isCod && paymentStatus === 'PENDING' && !TERMINAL_STATUSES.has(status) ? totalPaise : 0

  const f = o.fulfillment || {}
  const hasShipment = Boolean(
    f.carrier || f.trackingNumber || f.trackingUrl || f.shippedAt || f.deliveredAt,
  )

  return {
    orderNumber: o.orderNumber,
    placedAt: o.createdAt || null,
    lastUpdatedAt: o.updatedAt || o.createdAt || null,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    isCancelled: status === 'CANCELLED',
    isRefund: status === 'REFUND_PENDING' || status === 'REFUNDED',
    isDelivered: status === 'DELIVERED',
    hasPaymentIssue: PAYMENT_ISSUE_STATUSES.has(status),
    paymentMethod: isCod ? 'COD' : 'PREPAID',
    paymentMethodLabel: isCod ? 'Cash on Delivery' : 'Prepaid',
    paymentStatus,
    paymentStatusLabel:
      status === 'CANCELLED' && paymentStatus === 'PENDING'
        ? 'Not charged'
        : paymentStatusLabel(paymentStatus, isCod),
    amountDuePaise,
    items: (o.items || []).map((item) => {
      const { unit, total } = itemPaise(item)
      return {
        name: item.name,
        image: item.image || null,
        size: item.size || null,
        quantity: item.quantity,
        unitPricePaise: unit,
        totalPaise: total,
      }
    }),
    pricing: {
      subtotalPaise: Number(p.subtotalPaise ?? 0),
      shippingPaise: Number(p.shippingPaise ?? 0),
      discountPaise: Number(p.discountPaise ?? 0),
      convenienceFeePaise: Number(p.convenienceFeePaise ?? 0),
      codFeePaise: Number(p.codFeePaise ?? 0),
      totalPaise,
    },
    destination: {
      city: o.shippingAddress?.city || null,
      state: o.shippingAddress?.state || null,
    },
    shipment: hasShipment
      ? {
          carrier: f.carrier || null,
          trackingNumber: f.trackingNumber || null,
          trackingUrl: safeHttpUrl(f.trackingUrl),
          shippedAt: f.shippedAt || null,
          deliveredAt: f.deliveredAt || null,
        }
      : null,
    timeline: buildTimeline(o, status, isCod),
    updates: buildUpdates(o),
  }
}
