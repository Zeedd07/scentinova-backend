import mongoose from 'mongoose'
import { AnalyticsEvent } from '../models/AnalyticsEvent.js'
import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { Payment } from '../models/Payment.js'
import { ApiError } from '../utils/ApiError.js'
import { ORDER_TRANSITIONS, mapLegacyStatus } from '../utils/orderStatus.js'

const ALLOWED = new Set([
  'product_view',
  'add_to_cart',
  'checkout_started',
  'order_created',
])

export async function recordEvent({ type, productId, sessionId, metadata }) {
  if (!ALLOWED.has(type)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown analytics event type.')
  }

  // Client must not submit purchase/revenue events as truth
  if (type === 'order_created') {
    throw new ApiError(403, 'FORBIDDEN', 'Order analytics are recorded by the server.')
  }

  let pid = null
  if (productId) {
    if (!mongoose.isValidObjectId(productId)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid product id.')
    }
    const exists = await Product.exists({ _id: productId })
    if (!exists) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
    }
    pid = productId
  }

  // Soft de-dupe product views within 30 minutes for same session+product
  if (type === 'product_view' && sessionId && pid) {
    const since = new Date(Date.now() - 30 * 60 * 1000)
    const existing = await AnalyticsEvent.findOne({
      type: 'product_view',
      sessionId,
      productId: pid,
      createdAt: { $gte: since },
    })
    if (existing) {
      return { recorded: false, deduped: true }
    }
  }

  await AnalyticsEvent.create({
    type,
    productId: pid,
    sessionId: sessionId || null,
    metadata: metadata || {},
  })

  return { recorded: true }
}

// ── Revenue: only money that was actually collected ──────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000
const TIME_ZONE = 'Asia/Kolkata'
/** Longer spans are charted per month so the chart stays readable. */
const MAX_DAILY_BUCKETS = 92

export const ANALYTICS_RANGES = { '7d': 7, '30d': 30, '90d': 90, all: null }

export const REVENUE_STATE = {
  PAID: 'PAID',
  COD_AWAITING: 'COD_AWAITING',
  UNPAID: 'UNPAID',
}

const PAID_PAYMENT = new Set(['CAPTURED', 'PAID'])
const REFUNDED_PAYMENT = new Set(['REFUNDED', 'PARTIALLY_REFUNDED'])
const COD_UNCOLLECTED = new Set(['PENDING', 'CREATED', ''])
/** COD orders in these states will be (or were) handed over and paid in cash. */
const COD_OPEN_STATUSES = new Set([
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
])

const ORDER_FIELDS =
  'status paymentStatus paymentMethod payment pricing total subtotal shipping discount codFee convenienceFee items createdAt'

function orderStatus(order) {
  const raw = String(order.status || '')
  return ORDER_TRANSITIONS[raw] ? raw : mapLegacyStatus(raw, order.paymentStatus || order.payment?.status)
}

/** Payment state, preferring any value that proves money moved (legacy orders keep it top-level). */
function paymentState(order) {
  const values = [order.payment?.status, order.paymentStatus].map((v) => String(v || '').toUpperCase())
  return (
    values.find((v) => PAID_PAYMENT.has(v) || REFUNDED_PAYMENT.has(v)) ?? values.find(Boolean) ?? ''
  )
}

function isCod(order) {
  return order.paymentMethod === 'COD' || order.payment?.provider === 'cod'
}

function rupeesToPaise(value) {
  return value == null || Number.isNaN(Number(value)) ? 0 : Math.round(Number(value) * 100)
}

export function orderTotalPaise(order) {
  if (order.pricing?.totalPaise > 0) return order.pricing.totalPaise
  if (order.total != null) return rupeesToPaise(order.total)
  return (order.items || []).reduce((sum, item) => sum + itemRevenuePaise(item), 0)
}

function itemRevenuePaise(item) {
  if (item.totalPaise != null) return item.totalPaise
  if (item.lineTotal != null) return rupeesToPaise(item.lineTotal)
  return (item.unitPricePaise || 0) * (item.quantity || 0)
}

/**
 * PAID: the money was collected (Razorpay capture, or COD cash marked received).
 * COD_AWAITING: a live COD order whose cash has not been collected yet.
 * UNPAID: never paid - awaiting payment, failed, expired or cancelled.
 */
export function revenueState(order) {
  const pay = paymentState(order)
  if (PAID_PAYMENT.has(pay) || REFUNDED_PAYMENT.has(pay)) return REVENUE_STATE.PAID
  if (isCod(order) && COD_UNCOLLECTED.has(pay) && COD_OPEN_STATUSES.has(orderStatus(order))) {
    return REVENUE_STATE.COD_AWAITING
  }
  return REVENUE_STATE.UNPAID
}

/** Refunded (or refunding) amount of a paid order; a recorded refund amount wins over the status. */
export function orderRefundPaise(order, recordedPaise = 0) {
  const total = orderTotalPaise(order)
  if (recordedPaise > 0) return Math.min(recordedPaise, total)
  const status = orderStatus(order)
  if (paymentState(order) === 'REFUNDED' || status === 'REFUNDED' || status === 'REFUND_PENDING') {
    return total
  }
  return 0
}

function paidAt(order) {
  return new Date(order.payment?.capturedAt || order.payment?.receivedAt || order.createdAt)
}

function pricingPaise(order, key, legacyKey) {
  const value = order.pricing?.[key]
  if (value != null && (value > 0 || order.pricing?.totalPaise > 0)) return value
  return rupeesToPaise(order[legacyKey])
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function dayKey(date) {
  return dayFormatter.format(date)
}

/** Midnight (India time) at the start of the day `daysBack` days before `now`. */
function startOfDayIst(now, daysBack) {
  return new Date(`${dayKey(new Date(now.getTime() - daysBack * DAY_MS))}T00:00:00+05:30`)
}

function bucketKeys(fromDate, now) {
  const days = Math.max(1, Math.ceil((now - fromDate) / DAY_MS))
  const monthly = days > MAX_DAILY_BUCKETS
  const keys = []
  for (let t = fromDate.getTime(); t <= now.getTime() + DAY_MS; t += DAY_MS) {
    const d = new Date(Math.min(t, now.getTime()))
    const key = monthly ? dayKey(d).slice(0, 7) : dayKey(d)
    if (keys[keys.length - 1] !== key) keys.push(key)
  }
  return { keys, unit: monthly ? 'month' : 'day' }
}

async function refundsByOrder() {
  const rows = await Payment.find({ refundedPaise: { $gt: 0 } }, 'orderId refundedPaise').lean()
  const map = new Map()
  for (const row of rows) {
    const id = String(row.orderId)
    map.set(id, (map.get(id) || 0) + row.refundedPaise)
  }
  return map
}

function emptyMoney() {
  return {
    receivedPaise: 0,
    refundedPaise: 0,
    netPaise: 0,
    paidOrders: 0,
    averageOrderPaise: 0,
    online: { orders: 0, paise: 0 },
    cod: { orders: 0, paise: 0 },
    codAwaiting: { orders: 0, paise: 0 },
    unpaid: { orders: 0, cancelled: 0, failedOrExpired: 0, awaitingPayment: 0 },
    breakdown: {
      itemsPaise: 0,
      discountPaise: 0,
      shippingPaise: 0,
      codFeePaise: 0,
      convenienceFeePaise: 0,
      taxPaise: 0,
    },
  }
}

/**
 * Admin analytics report for the last 7, 30 or 90 calendar days (India time, today included) or `all`.
 * Money uses the day it was collected; unpaid and COD-awaiting orders use the day they were placed.
 */
export async function getAnalyticsReport({ range = '30d', now = new Date() } = {}) {
  if (!Object.hasOwn(ANALYTICS_RANGES, range)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Range must be one of 7d, 30d, 90d or all.')
  }
  const days = ANALYTICS_RANGES[range]
  const from = days ? startOfDayIst(now, days - 1) : null
  const inRange = (date) => (!from || date >= from) && date <= now
  const eventMatch = from ? { createdAt: { $gte: from, $lte: now } } : {}

  const [orders, refunds, products, views, addToCarts, checkoutStarted, viewAgg, cartAgg] =
    await Promise.all([
      Order.find({}, ORDER_FIELDS).lean(),
      refundsByOrder(),
      Product.find({}, 'name slug category stock active').sort({ name: 1 }).lean(),
      AnalyticsEvent.countDocuments({ type: 'product_view', ...eventMatch }),
      AnalyticsEvent.countDocuments({ type: 'add_to_cart', ...eventMatch }),
      AnalyticsEvent.countDocuments({ type: 'checkout_started', ...eventMatch }),
      AnalyticsEvent.aggregate([
        { $match: { type: 'product_view', productId: { $ne: null }, ...eventMatch } },
        { $group: { _id: '$productId', n: { $sum: 1 } } },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { type: 'add_to_cart', productId: { $ne: null }, ...eventMatch } },
        { $group: { _id: '$productId', n: { $sum: 1 } } },
      ]),
    ])

  const money = emptyMoney()
  const productSales = new Map()
  const series = new Map()
  let firstPaidAt = null

  for (const order of orders) {
    const state = revenueState(order)
    const total = orderTotalPaise(order)

    if (state !== REVENUE_STATE.PAID) {
      if (!inRange(new Date(order.createdAt))) continue
      if (state === REVENUE_STATE.COD_AWAITING) {
        money.codAwaiting.orders += 1
        money.codAwaiting.paise += total
        continue
      }
      const status = orderStatus(order)
      money.unpaid.orders += 1
      if (status === 'CANCELLED') money.unpaid.cancelled += 1
      else if (status === 'PAYMENT_FAILED' || status === 'PAYMENT_EXPIRED') money.unpaid.failedOrExpired += 1
      else money.unpaid.awaitingPayment += 1
      continue
    }

    const when = paidAt(order)
    if (!firstPaidAt || when < firstPaidAt) firstPaidAt = when
    if (!inRange(when)) continue

    const refund = orderRefundPaise(order, refunds.get(String(order._id)) || 0)
    money.paidOrders += 1
    money.receivedPaise += total
    money.refundedPaise += refund
    const channel = isCod(order) ? money.cod : money.online
    channel.orders += 1
    channel.paise += total

    const b = money.breakdown
    b.itemsPaise += pricingPaise(order, 'subtotalPaise', 'subtotal')
    b.discountPaise += pricingPaise(order, 'discountPaise', 'discount')
    b.shippingPaise += pricingPaise(order, 'shippingPaise', 'shipping')
    b.codFeePaise += pricingPaise(order, 'codFeePaise', 'codFee')
    b.convenienceFeePaise += pricingPaise(order, 'convenienceFeePaise', 'convenienceFee')
    b.taxPaise += order.pricing?.taxPaise || 0

    const key = dayKey(when)
    const point = series.get(key) || { receivedPaise: 0, refundedPaise: 0, orders: 0 }
    point.receivedPaise += total
    point.refundedPaise += refund
    point.orders += 1
    series.set(key, point)

    // Fully refunded or cancelled orders didn't sell anything
    if (refund >= total || orderStatus(order) === 'CANCELLED') continue
    for (const item of order.items || []) {
      const id = item.productId ? String(item.productId) : null
      if (!id) continue
      const row = productSales.get(id) || { units: 0, paise: 0 }
      row.units += item.quantity || 0
      row.paise += itemRevenuePaise(item)
      productSales.set(id, row)
    }
  }

  money.netPaise = money.receivedPaise - money.refundedPaise
  money.averageOrderPaise = money.paidOrders ? Math.round(money.receivedPaise / money.paidOrders) : 0

  const chartFrom = from || firstPaidAt || now
  const { keys, unit } = bucketKeys(chartFrom, now)
  const merged = new Map()
  for (const [key, point] of series) {
    const bucket = unit === 'month' ? key.slice(0, 7) : key
    const acc = merged.get(bucket) || { receivedPaise: 0, refundedPaise: 0, orders: 0 }
    acc.receivedPaise += point.receivedPaise
    acc.refundedPaise += point.refundedPaise
    acc.orders += point.orders
    merged.set(bucket, acc)
  }
  const timeline = keys.map((key) => {
    const p = merged.get(key) || { receivedPaise: 0, refundedPaise: 0, orders: 0 }
    return { key, ...p, netPaise: p.receivedPaise - p.refundedPaise }
  })

  const viewsMap = new Map(viewAgg.map((r) => [String(r._id), r.n]))
  const cartMap = new Map(cartAgg.map((r) => [String(r._id), r.n]))
  const categories = new Map()
  const productRows = products.map((p) => {
    const id = String(p._id)
    const sales = productSales.get(id) || { units: 0, paise: 0 }
    if (sales.units) {
      const name = p.category || 'Other'
      const c = categories.get(name) || { category: name, units: 0, revenuePaise: 0 }
      c.units += sales.units
      c.revenuePaise += sales.paise
      categories.set(name, c)
    }
    return {
      id,
      name: p.name,
      slug: p.slug,
      category: p.category || null,
      stock: p.stock ?? null,
      active: p.active !== false,
      views: viewsMap.get(id) || 0,
      addToCarts: cartMap.get(id) || 0,
      unitsSold: sales.units,
      revenuePaise: sales.paise,
    }
  })

  return {
    range: { key: range, from: from ? from.toISOString() : null, to: now.toISOString() },
    money,
    funnel: { views, addToCarts, checkoutStarted, paidOrders: money.paidOrders },
    timeline: { unit, points: timeline },
    products: productRows,
    categories: [...categories.values()].sort((a, b) => b.revenuePaise - a.revenuePaise),
    generatedAt: now.toISOString(),
  }
}

/** Admin dashboard KPIs (all time). Revenue is net money collected, in rupees. */
export async function getOverview() {
  const [report, productCount, activeCount, recentOrders, lowStock] = await Promise.all([
    getAnalyticsReport({ range: 'all' }),
    Product.countDocuments(),
    Product.countDocuments({ active: true }),
    Order.find().sort({ createdAt: -1 }).limit(8),
    Product.find({ active: true, stock: { $lte: 8 } }).sort({ stock: 1 }).limit(12),
  ])
  const { money, funnel } = report

  return {
    products: productCount,
    activeProducts: activeCount,
    views: funnel.views,
    addToCarts: funnel.addToCarts,
    checkoutStarted: funnel.checkoutStarted,
    orders: money.paidOrders,
    unitsSold: report.products.reduce((sum, p) => sum + p.unitsSold, 0),
    revenue: money.netPaise / 100,
    codAwaitingRevenue: money.codAwaiting.paise / 100,
    conversionRate: funnel.views ? Number(((money.paidOrders / funnel.views) * 100).toFixed(2)) : 0,
    lowStock: lowStock.map((p) => p.toJSON()),
    recentOrders: recentOrders.map((o) => o.toJSON()),
  }
}

/** Per-product totals (all time); revenue in rupees. Kept for older admin clients. */
export async function getProductAnalytics() {
  const report = await getAnalyticsReport({ range: 'all' })
  return {
    products: report.products.map((p) => ({
      ...p,
      purchases: p.unitsSold,
      revenue: p.revenuePaise / 100,
    })),
    byCategory: report.categories.map((c) => ({ category: c.category, units: c.units })),
  }
}
