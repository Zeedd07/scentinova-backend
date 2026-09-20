import { Order } from '../models/Order.js'
import { Shipment } from '../models/Shipment.js'
import { Payment } from '../models/Payment.js'
import { ApiError } from '../utils/ApiError.js'
import { canTransition, mapLegacyStatus } from '../utils/orderStatus.js'
import { writeAudit } from './auditService.js'
import { notify, NotificationEvent } from './emailService.js'
import { releaseReservations } from './inventoryService.js'
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
  return o
}

export async function listAdminOrders(query = {}) {
  const filter = {}
  if (query.status) filter.status = query.status
  if (query.q) {
    const re = new RegExp(String(query.q).trim(), 'i')
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

  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50))
  const skip = (page - 1) * limit

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
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

export async function updateOrderStatus(id, status, { admin, note, shipping } = {}) {
  const order = await Order.findById(id)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  let current = order.status
  // Normalize legacy
  if (!canTransition(current, status) && ['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'].includes(current)) {
    current = mapLegacyStatus(current, order.paymentStatus || order.payment?.status)
    order.status = current
  }

  // Admin must never mark paid manually
  if (status === 'CONFIRMED' && order.payment?.status !== 'CAPTURED') {
    throw new ApiError(
      400,
      'INVALID_ORDER_STATUS',
      'Payment must be captured by Razorpay before the order is confirmed.',
    )
  }

  if (current !== status && !canTransition(current, status)) {
    throw new ApiError(
      400,
      'INVALID_ORDER_STATUS',
      `Cannot change status from ${current} to ${status}.`,
    )
  }

  if (status === 'SHIPPED') {
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

  if (status === 'DELIVERED') {
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
    if (!order.inventoryCommitted) {
      await releaseReservations(order._id, 'RELEASED')
    }
    order.fulfillmentStatus = 'cancelled'
  }

  const prev = order.status
  order.status = status
  order.statusHistory.push({
    previousStatus: prev,
    status,
    changedBy: admin?.email || admin?.id || null,
    source: 'ADMIN',
    note: note || null,
    createdAt: new Date(),
  })
  await order.save()

  await writeAudit({
    actorType: 'ADMIN',
    actorId: admin?._id?.toString() || admin?.id || null,
    action: 'ORDER_STATUS_CHANGED',
    entityType: 'Order',
    entityId: order._id,
    metadata: { from: prev, to: status, orderNumber: order.orderNumber },
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

export async function refundOrder(id, { amountPaise, reason, admin } = {}) {
  const order = await Order.findById(id)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  if (order.payment?.status !== 'CAPTURED' || !order.payment?.razorpayPaymentId) {
    throw new ApiError(400, 'REFUND_NOT_ALLOWED', 'Only captured payments can be refunded.')
  }

  const maxPaise = order.pricing?.totalPaise || order.payment.amountPaise
  const refundAmount = amountPaise != null ? Number(amountPaise) : maxPaise
  if (!Number.isInteger(refundAmount) || refundAmount < 100 || refundAmount > maxPaise) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid refund amount.')
  }

  if (order.status === 'REFUNDED') {
    throw new ApiError(400, 'REFUND_NOT_ALLOWED', 'Order is already fully refunded.')
  }

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
        status: refundAmount >= maxPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      },
    },
  )

  // Webhook should finalize; optimistically mark when provider returns processed
  if (refund.status === 'processed') {
    order.status = 'REFUNDED'
    order.payment.status = refundAmount >= maxPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    order.paymentStatus = 'refunded'
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
    totalPaise: refundAmount,
    status: order.status,
  })

  return normalizeOrderView(order)
}

/** Legacy public create — blocked in favor of prepaid checkout. */
export async function createOrder() {
  throw new ApiError(
    410,
    'GONE',
    'Direct order creation is disabled. Use prepaid checkout.',
  )
}
