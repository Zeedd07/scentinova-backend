import mongoose from 'mongoose'
import { Order } from '../models/Order.js'
import { Shipment } from '../models/Shipment.js'
import { Payment } from '../models/Payment.js'
import { ApiError } from '../utils/ApiError.js'
import {
  adminNextStatuses,
  adminStatusPath,
  canTransition,
  mapLegacyStatus,
} from '../utils/orderStatus.js'
import { writeAudit } from './auditService.js'
import { notify, NotificationEvent } from './emailService.js'
import { releaseReservations, restockCommittedReservations } from './inventoryService.js'
import * as razorpayService from './razorpayService.js'
import { paiseToRupees } from '../utils/money.js'

function normalizeOrderView(order) {
  const o = order.toJSON()
  // Backfill display helpers for legacy admin UI
  if (o.pricing?.totalPaise != null && o.total == null) {
    o.total = paiseToRupees(o.pricing.totalPaise)
  }
  if (!o.customer && o.customerSnapshot) {
    o.customer = {
      name: o.customerSnapshot.name,
      email: o.customerSnapshot.email,
      phone: o.customerSnapshot.phone,
    }
  }
  o.allowedNextStatuses = adminNextStatuses(o)
  return o
}

const PAYMENT_FILTERS = new Set(['PREPAID', 'COD'])
const SORT_KEYS = {
  newest: ['createdAt', -1],
  oldest: ['createdAt', 1],
  'amount-high': ['pricing.totalPaise', -1],
  'amount-low': ['pricing.totalPaise', 1],
}

function buildOrderSort(value) {
  if (value == null || value === '') return { createdAt: -1 }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid sort.')
  const keys = value.split(',').map((part) => part.trim()).filter(Boolean)
  if (!keys.length || keys.length > 3 || keys.some((key) => !SORT_KEYS[key])) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid sort.')
  }
  const sort = {}
  const used = new Set()
  for (const key of keys) {
    const [field, direction] = SORT_KEYS[key]
    if (used.has(field)) continue
    used.add(field)
    sort[field] = direction
  }
  if (sort.createdAt == null) sort.createdAt = -1
  return sort
}

export async function listAdminOrders(query = {}) {
  const filter = {}
  if (query.status != null && typeof query.status !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid status filter.')
  }
  if (query.status) filter.status = query.status
  if (query.q != null && typeof query.q !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid search.')
  }
  if (query.q) {
    const re = new RegExp(String(query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    filter.$or = [
      { orderNumber: re },
      { 'customerSnapshot.name': re },
      { 'customerSnapshot.email': re },
      { 'customerSnapshot.phone': re },
      { 'customer.name': re },
      { 'customer.email': re },
      { 'payment.razorpayOrderId': re },
      { 'payment.razorpayPaymentId': re },
      { 'fulfillment.trackingNumber': re },
    ]
  }
  if (query.method != null && query.method !== '') {
    if (typeof query.method !== 'string' || !PAYMENT_FILTERS.has(query.method)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Payment filter must be prepaid or cash on delivery.')
    }
    filter.paymentMethod = query.method
  }
  if (query.product != null && query.product !== '') {
    if (typeof query.product !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid product filter.')
    }
    const ids = [...new Set(query.product.split(',').map((part) => part.trim()).filter(Boolean))]
    if (!ids.length || ids.length > 30 || ids.some((id) => !mongoose.isValidObjectId(id))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid product filter.')
    }
    filter['items.productId'] = { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }
  }

  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50))
  const skip = (page - 1) * limit
  const sort = buildOrderSort(query.sort)

  const [orders, total] = await Promise.all([
    Order.find(filter).sort(sort).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ])

  return {
    orders: orders.map(normalizeOrderView),
    meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  }
}

export async function getAdminOrder(id) {
  const order = await Order.findById(id)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  const shipment = await Shipment.findOne({ orderId: order._id })
  const payments = await Payment.find({ orderId: order._id }).sort({ createdAt: -1 })
  return {
    ...normalizeOrderView(order),
    shipment: shipment ? shipment.toJSON() : null,
    payments: payments.map((p) => p.toJSON()),
  }
}

export async function updateOrderStatus(
  id,
  status,
  { admin, note, customerMessage, shipping } = {},
) {
  const order = await Order.findById(id)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  let current = order.status
  // Normalize legacy
  if (!canTransition(current, status) && ['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'].includes(current)) {
    current = mapLegacyStatus(current, order.paymentStatus || order.payment?.status)
    order.status = current
  }

  // Admin must never mark prepaid orders confirmed without Razorpay capture
  const isCod = order.paymentMethod === 'COD' || order.payment?.provider === 'cod'
  if (
    status === 'CONFIRMED' &&
    !isCod &&
    order.payment?.status !== 'CAPTURED' &&
    order.payment?.status !== 'PAID'
  ) {
    throw new ApiError(
      400,
      'INVALID_ORDER_STATUS',
      'Payment must be captured by Razorpay before the order is confirmed.',
    )
  }

  // Re-applying the current status would re-stamp dates and re-send customer emails
  if (current === status) {
    throw new ApiError(
      400,
      'INVALID_ORDER_STATUS',
      `Order is already ${status}. Post an update instead to message the customer.`,
    )
  }

  const path = adminStatusPath(current, status)
  if (!path) {
    throw new ApiError(
      400,
      'INVALID_ORDER_STATUS',
      `Cannot change status from ${current} to ${status}.`,
    )
  }

  if (path.includes('SHIPPED')) {
    const carrier = shipping?.carrier || order.fulfillment?.carrier
    const trackingNumber = shipping?.trackingNumber || order.fulfillment?.trackingNumber
    if (!carrier || !trackingNumber) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Carrier and tracking number are required to mark shipped.',
      )
    }
    order.fulfillment = {
      ...(order.fulfillment?.toObject?.() || order.fulfillment || {}),
      carrier,
      trackingNumber,
      trackingUrl: shipping?.trackingUrl || order.fulfillment?.trackingUrl || null,
      status: 'IN_TRANSIT',
      shippedAt: new Date(),
    }
    await Shipment.findOneAndUpdate(
      { orderId: order._id },
      {
        $set: {
          provider: 'manual',
          carrier,
          trackingNumber,
          trackingUrl: shipping?.trackingUrl || null,
          status: 'IN_TRANSIT',
          shippedAt: new Date(),
        },
        $push: {
          events: {
            status: 'IN_TRANSIT',
            description: 'Shipped',
            timestamp: new Date(),
          },
        },
      },
      { upsert: true },
    )
  }

  if (path.includes('DELIVERED')) {
    order.fulfillment = {
      ...(order.fulfillment?.toObject?.() || order.fulfillment || {}),
      status: 'DELIVERED',
      deliveredAt: new Date(),
    }
    order.fulfillmentStatus = 'fulfilled'
  }

  if (status === 'CANCELLED') {
    if (['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(current)) {
      throw new ApiError(
        400,
        'INVALID_ORDER_STATUS',
        'Shipped/delivered orders must use the return/refund workflow.',
      )
    }
    if (order.inventoryCommitted) {
      await restockCommittedReservations(order._id)
    } else {
      await releaseReservations(order._id, 'RELEASED')
    }
    order.fulfillmentStatus = 'cancelled'
  }

  const prev = order.status
  const changedAt = new Date()
  let from = prev
  path.forEach((step, i) => {
    const last = i === path.length - 1
    order.statusHistory.push({
      previousStatus: from,
      status: step,
      changedBy: admin?.email || admin?.id || null,
      source: 'ADMIN',
      note: last ? note || null : null,
      customerMessage: last ? customerMessage || null : null,
      createdAt: changedAt,
    })
    from = step
  })
  order.status = status
  await order.save()

  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin?._id?.toString() || admin?.id || null,
    action: 'ORDER_STATUS_CHANGED',
    entityType: 'Order',
    entityId: order._id,
    metadata: { from: prev, to: status, via: path, orderNumber: order.orderNumber },
  })

  if (status === 'SHIPPED') {
    await notify(NotificationEvent.ORDER_SHIPPED, {
      orderNumber: order.orderNumber,
      email: order.customerSnapshot?.email || order.customer?.email,
      status,
    })
  }
  if (status === 'OUT_FOR_DELIVERY') {
    await notify(NotificationEvent.OUT_FOR_DELIVERY, {
      orderNumber: order.orderNumber,
      email: order.customerSnapshot?.email || order.customer?.email,
      status,
    })
  }
  if (status === 'DELIVERED') {
    await notify(NotificationEvent.ORDER_DELIVERED, {
      orderNumber: order.orderNumber,
      email: order.customerSnapshot?.email || order.customer?.email,
      status,
    })
  }
  if (status === 'CANCELLED') {
    await notify(NotificationEvent.ORDER_CANCELLED, {
      orderNumber: order.orderNumber,
      email: order.customerSnapshot?.email || order.customer?.email,
      status,
    })
  }

  return normalizeOrderView(order)
}

/** Timeline entry without a status change, e.g. a delivery delay notice. */
export async function addOrderUpdate(id, { admin, note, customerMessage } = {}) {
  const order = await Order.findById(id)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  order.statusHistory.push({
    previousStatus: order.status,
    status: order.status,
    changedBy: admin?.email || admin?.id || null,
    source: 'ADMIN',
    note: note || null,
    customerMessage: customerMessage || null,
    createdAt: new Date(),
  })
  await order.save()

  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin?._id?.toString() || admin?.id || null,
    action: 'ORDER_UPDATE_POSTED',
    entityType: 'Order',
    entityId: order._id,
    metadata: { orderNumber: order.orderNumber, customerVisible: Boolean(customerMessage) },
  })

  return normalizeOrderView(order)
}

export async function updateShipping(id, shipping, { admin } = {}) {
  const order = await Order.findById(id)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  order.fulfillment = {
    ...(order.fulfillment?.toObject?.() || order.fulfillment || {}),
    carrier: shipping.carrier,
    trackingNumber: shipping.trackingNumber,
    trackingUrl: shipping.trackingUrl || null,
    shipmentId: shipping.shipmentId || order.fulfillment?.shipmentId || null,
  }
  await order.save()

  await Shipment.findOneAndUpdate(
    { orderId: order._id },
    {
      $set: {
        provider: 'manual',
        carrier: shipping.carrier,
        trackingNumber: shipping.trackingNumber,
        trackingUrl: shipping.trackingUrl || null,
        shipmentId: shipping.shipmentId || null,
      },
    },
    { upsert: true },
  )

  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin?._id?.toString() || null,
    action: 'ORDER_SHIPPING_UPDATED',
    entityType: 'Order',
    entityId: order._id,
    metadata: { trackingNumber: shipping.trackingNumber },
  })

  return normalizeOrderView(order)
}

export async function markCodPaymentReceived(id, { admin, note } = {}) {
  const order = await Order.findById(id)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  const isCod = order.paymentMethod === 'COD' || order.payment?.provider === 'cod'
  if (!isCod) {
    throw new ApiError(
      400,
      'INVALID_PAYMENT_ACTION',
      'Only COD orders can be marked as cash received.',
    )
  }

  const currentPay = String(order.payment?.status || order.paymentStatus || '').toUpperCase()
  if (currentPay === 'PAID' || currentPay === 'CAPTURED') {
    return normalizeOrderView(order)
  }
  if (currentPay === 'REFUNDED' || currentPay === 'PARTIALLY_REFUNDED') {
    throw new ApiError(
      400,
      'INVALID_PAYMENT_ACTION',
      'Cannot mark a refunded COD order as paid.',
    )
  }
  if (currentPay && currentPay !== 'PENDING' && currentPay !== 'CREATED') {
    throw new ApiError(
      400,
      'INVALID_PAYMENT_ACTION',
      `Cannot mark COD payment received from status ${order.payment?.status}.`,
    )
  }

  const receivedAt = new Date()
  order.payment = {
    ...(order.payment?.toObject?.() || order.payment || {}),
    provider: 'cod',
    status: 'PAID',
    method: 'COD',
    amountPaise: order.pricing?.totalPaise || order.payment?.amountPaise,
    currency: 'INR',
    receivedAt,
    capturedAt: receivedAt,
  }
  order.paymentStatus = 'PAID'
  order.paymentMethod = 'COD'
  // Never invent Razorpay IDs for COD
  if (order.payment.razorpayOrderId == null) delete order.payment.razorpayOrderId
  if (order.payment.razorpayPaymentId == null) delete order.payment.razorpayPaymentId

  order.statusHistory.push({
    previousStatus: order.status,
    status: order.status,
    changedBy: admin?.email || admin?.id || null,
    source: 'ADMIN',
    note: note || 'COD payment marked as received',
    createdAt: receivedAt,
  })
  await order.save()

  await Payment.findOneAndUpdate(
    { orderId: order._id, provider: 'cod' },
    {
      $set: {
        orderNumber: order.orderNumber,
        provider: 'cod',
        status: 'PAID',
        method: 'COD',
        capturedAt: receivedAt,
        amountPaise: order.pricing?.totalPaise || order.payment?.amountPaise,
        currency: 'INR',
      },
      $unset: { razorpayOrderId: '', razorpayPaymentId: '' },
    },
    { upsert: true },
  )

  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin?._id?.toString() || admin?.id || null,
    action: 'COD_PAYMENT_RECEIVED',
    entityType: 'Order',
    entityId: order._id,
    metadata: {
      orderNumber: order.orderNumber,
      amountPaise: order.pricing?.totalPaise,
      note: note || null,
    },
  })

  return normalizeOrderView(order)
}

export async function refundOrder(id, { amountPaise, reason, admin } = {}) {
  const order = await Order.findById(id)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  const isCod = order.paymentMethod === 'COD' || order.payment?.provider === 'cod'
  if (isCod) {
    return refundCodOrder(order, { amountPaise, reason, admin })
  }

  if (order.payment?.status !== 'CAPTURED' || !order.payment?.razorpayPaymentId) {
    throw new ApiError(400, 'REFUND_NOT_ALLOWED', 'Only captured payments can be refunded.')
  }

  const maxPaise = order.pricing?.totalPaise || order.payment.amountPaise
  const existing = await Payment.findOne({ orderId: order._id }).select('refundedPaise')
  const alreadyRefunded = existing?.refundedPaise || 0
  const remainingPaise = maxPaise - alreadyRefunded
  if (order.status === 'REFUNDED' || remainingPaise <= 0) {
    throw new ApiError(400, 'REFUND_NOT_ALLOWED', 'Order is already fully refunded.')
  }

  const refundAmount = amountPaise != null ? Number(amountPaise) : remainingPaise
  if (!Number.isInteger(refundAmount) || refundAmount < 100 || refundAmount > remainingPaise) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid refund amount.')
  }
  const fullyRefunded = alreadyRefunded + refundAmount >= maxPaise

  if (!razorpayService.isRazorpayReady()) {
    throw new ApiError(501, 'PAYMENT_UNAVAILABLE', 'Razorpay is not configured.')
  }

  const prev = order.status
  order.status = 'REFUND_PENDING'
  order.statusHistory.push({
    previousStatus: prev,
    status: 'REFUND_PENDING',
    changedBy: admin?.email || null,
    source: 'ADMIN',
    note: reason || 'Refund initiated',
    createdAt: new Date(),
  })
  await order.save()

  const refund = await razorpayService.createRefund({
    paymentId: order.payment.razorpayPaymentId,
    amountPaise: refundAmount,
    notes: { orderNumber: order.orderNumber, reason: reason || '' },
  })

  await Payment.findOneAndUpdate(
    { orderId: order._id },
    {
      $addToSet: { refundIds: refund.id },
      $inc: { refundedPaise: refundAmount },
      $set: {
        status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      },
    },
  )

  // Webhook should finalize; optimistically mark when provider returns processed
  if (refund.status === 'processed') {
    order.status = 'REFUNDED'
    order.payment.status = fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    order.paymentStatus = 'REFUNDED'
    order.statusHistory.push({
      previousStatus: 'REFUND_PENDING',
      status: 'REFUNDED',
      source: 'SYSTEM',
      note: 'Refund processed',
      createdAt: new Date(),
    })
    await order.save()
  }

  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin?._id?.toString() || null,
    action: 'ORDER_REFUND_INITIATED',
    entityType: 'Order',
    entityId: order._id,
    metadata: { refundId: refund.id, amountPaise: refundAmount },
  })

  await notify(NotificationEvent.REFUND_INITIATED, {
    orderNumber: order.orderNumber,
    email: order.customerSnapshot?.email || order.customer?.email,
    paymentMethod: order.paymentMethod || 'PREPAID',
    paymentStatus: order.paymentStatus,
    totalPaise: refundAmount,
    status: order.status,
  })

  return normalizeOrderView(order)
}

/**
 * Internal COD refund / payment adjustment — never calls Razorpay.
 */
async function refundCodOrder(order, { amountPaise, reason, admin } = {}) {
  const maxPaise = order.pricing?.totalPaise || order.payment?.amountPaise || 0
  const refundAmount = amountPaise != null ? Number(amountPaise) : maxPaise
  if (!Number.isInteger(refundAmount) || refundAmount < 100 || refundAmount > maxPaise) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid refund amount.')
  }
  if (order.status === 'REFUNDED') {
    throw new ApiError(400, 'REFUND_NOT_ALLOWED', 'Order is already fully refunded.')
  }

  const payStatus = String(order.payment?.status || '').toUpperCase()
  const prev = order.status
  const full = refundAmount >= maxPaise

  if (payStatus === 'PENDING' || payStatus === 'CREATED') {
    // Never collected — cancel / close without inventing a Razorpay refund
    if (order.inventoryCommitted && !['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(prev)) {
      await restockCommittedReservations(order._id)
    }
    order.status = 'CANCELLED'
    order.payment = {
      ...(order.payment?.toObject?.() || order.payment || {}),
      provider: 'cod',
      status: 'FAILED',
      failureReason: reason || 'COD order cancelled before collection',
    }
    order.paymentStatus = 'FAILED'
    order.statusHistory.push({
      previousStatus: prev,
      status: 'CANCELLED',
      changedBy: admin?.email || null,
      source: 'ADMIN',
      note: reason || 'COD order cancelled (payment never collected)',
      createdAt: new Date(),
    })
  } else {
    order.status = 'REFUNDED'
    order.payment = {
      ...(order.payment?.toObject?.() || order.payment || {}),
      provider: 'cod',
      status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    }
    order.paymentStatus = full ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    order.statusHistory.push({
      previousStatus: prev,
      status: 'REFUNDED',
      changedBy: admin?.email || null,
      source: 'ADMIN',
      note: reason || 'Internal COD refund recorded',
      createdAt: new Date(),
    })
  }

  await order.save()

  await Payment.findOneAndUpdate(
    { orderId: order._id, provider: 'cod' },
    {
      $inc: { refundedPaise: refundAmount },
      $set: {
        status:
          payStatus === 'PENDING' || payStatus === 'CREATED'
            ? 'FAILED'
            : full
              ? 'REFUNDED'
              : 'PARTIALLY_REFUNDED',
      },
    },
    { upsert: true },
  )

  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin?._id?.toString() || null,
    action: 'COD_REFUND_RECORDED',
    entityType: 'Order',
    entityId: order._id,
    metadata: {
      amountPaise: refundAmount,
      reason: reason || null,
      pricingSnapshot: {
        subtotalPaise: order.pricing?.subtotalPaise,
        shippingPaise: order.pricing?.shippingPaise,
        codFeePaise: order.pricing?.codFeePaise,
        convenienceFeePaise: order.pricing?.convenienceFeePaise,
        discountPaise: order.pricing?.discountPaise,
        totalPaise: order.pricing?.totalPaise,
      },
    },
  })

  await notify(NotificationEvent.REFUND_INITIATED, {
    orderNumber: order.orderNumber,
    email: order.customerSnapshot?.email || order.customer?.email,
    paymentMethod: 'COD',
    paymentStatus: order.paymentStatus,
    codFeePaise: order.pricing?.codFeePaise,
    convenienceFeePaise: order.pricing?.convenienceFeePaise,
    totalPaise: refundAmount,
    status: order.status,
  })

  return normalizeOrderView(order)
}

/** Legacy public create — blocked in favor of prepaid/COD checkout. */
export async function createOrder() {
  throw new ApiError(
    410,
    'GONE',
    'Direct order creation is disabled. Use checkout.',
  )
}
