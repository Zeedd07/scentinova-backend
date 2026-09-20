import crypto from 'crypto'
import { Order } from '../models/Order.js'
import { Payment } from '../models/Payment.js'
import { PaymentAttempt } from '../models/PaymentAttempt.js'
import { WebhookEvent } from '../models/WebhookEvent.js'
import { ApiError } from '../utils/ApiError.js'
import * as razorpayService from './razorpayService.js'
import { commitReservations, releaseReservations } from './inventoryService.js'
import { writeAudit } from './auditService.js'
import { notify, NotificationEvent } from './emailService.js'
import { canTransition } from '../utils/orderStatus.js'
import { logger } from '../utils/logger.js'
import { toCustomerOrder } from './checkoutService.js'

/**
 * Mark order paid exactly once — idempotent on razorpayPaymentId / already CONFIRMED.
 */
export async function confirmPaidOrder({
  order,
  razorpayPaymentId,
  razorpayOrderId,
  method = null,
  source = 'SYSTEM',
}) {
  if (order.status === 'CONFIRMED' || order.payment?.status === 'CAPTURED') {
    if (
      razorpayPaymentId &&
      order.payment?.razorpayPaymentId &&
      order.payment.razorpayPaymentId !== razorpayPaymentId
    ) {
      logger.warn('confirmPaidOrder mismatched payment id on confirmed order', {
        orderNumber: order.orderNumber,
      })
    }
    return { order, alreadyConfirmed: true }
  }

  if (razorpayPaymentId) {
    const clash = await Order.findOne({
      'payment.razorpayPaymentId': razorpayPaymentId,
      _id: { $ne: order._id },
    })
    if (clash) {
      throw new ApiError(409, 'PAYMENT_ALREADY_PROCESSED', 'Payment already linked to another order.')
    }
  }

  const prev = order.status
  if (prev !== 'CONFIRMED' && !canTransition(prev, 'CONFIRMED') && prev !== 'PAYMENT_PROCESSING') {
    // Allow PENDING_PAYMENT / PAYMENT_FAILED / PAYMENT_PROCESSING → CONFIRMED
    if (!['PENDING_PAYMENT', 'PAYMENT_FAILED', 'PAYMENT_PROCESSING'].includes(prev)) {
      throw new ApiError(400, 'INVALID_ORDER_STATUS', `Cannot confirm order from ${prev}.`)
    }
  }

  await commitReservations(order._id)

  order.status = 'CONFIRMED'
  order.payment = {
    ...(order.payment?.toObject?.() || order.payment || {}),
    provider: 'razorpay',
    razorpayOrderId: razorpayOrderId || order.payment?.razorpayOrderId,
    razorpayPaymentId: razorpayPaymentId || order.payment?.razorpayPaymentId,
    status: 'CAPTURED',
    method,
    amountPaise: order.pricing?.totalPaise || order.payment?.amountPaise,
    currency: 'INR',
    capturedAt: new Date(),
    failedAt: null,
    failureReason: null,
  }
  order.paymentStatus = 'paid'
  order.inventoryCommitted = true
  order.stockDecremented = true
  order.statusHistory.push({
    previousStatus: prev,
    status: 'CONFIRMED',
    source: source === 'RAZORPAY_WEBHOOK' ? 'RAZORPAY_WEBHOOK' : 'SYSTEM',
    note: 'Payment captured',
    createdAt: new Date(),
  })
  await order.save()

  await Payment.findOneAndUpdate(
    { orderId: order._id, razorpayOrderId: order.payment.razorpayOrderId },
    {
      $set: {
        razorpayPaymentId: order.payment.razorpayPaymentId,
        status: 'CAPTURED',
        method,
        capturedAt: order.payment.capturedAt,
      },
    },
    { upsert: true },
  )

  await PaymentAttempt.create({
    orderId: order._id,
    razorpayOrderId: order.payment.razorpayOrderId,
    razorpayPaymentId: order.payment.razorpayPaymentId,
    amountPaise: order.payment.amountPaise,
    currency: 'INR',
    status: 'CAPTURED',
    method,
  })

  await writeAudit({
    actorType: source === 'RAZORPAY_WEBHOOK' ? 'WEBHOOK' : 'SYSTEM',
    action: 'PAYMENT_CAPTURED',
    entityType: 'Order',
    entityId: order._id,
    metadata: {
      orderNumber: order.orderNumber,
      razorpayPaymentId: order.payment.razorpayPaymentId,
    },
  })

  await notify(NotificationEvent.PAYMENT_SUCCESS, {
    orderNumber: order.orderNumber,
    email: order.customerSnapshot?.email || order.customer?.email,
    totalPaise: order.pricing?.totalPaise,
    status: order.status,
  })
  await notify(NotificationEvent.ORDER_CONFIRMED, {
    orderNumber: order.orderNumber,
    email: order.customerSnapshot?.email || order.customer?.email,
    totalPaise: order.pricing?.totalPaise,
    status: order.status,
  })

  return { order, alreadyConfirmed: false }
}

export async function verifyCheckoutPayment({
  orderNumber,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) {
  const order = await Order.findOne({ orderNumber })
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  if (order.payment?.razorpayOrderId && order.payment.razorpayOrderId !== razorpayOrderId) {
    throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'Razorpay order mismatch.')
  }

  razorpayService.verifyPaymentSignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  })

  // Optional: fetch payment from Razorpay to confirm captured/authorized amount
  let method = null
  try {
    const payment = await razorpayService.fetchPayment(razorpayPaymentId)
    const expected = order.pricing?.totalPaise
    if (expected != null && Number(payment.amount) !== Number(expected)) {
      throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'Paid amount mismatch.')
    }
    if (!['captured', 'authorized'].includes(String(payment.status))) {
      throw new ApiError(400, 'PAYMENT_FAILED', 'Payment is not successful yet.')
    }
    method = payment.method || null
  } catch (err) {
    if (err instanceof ApiError) throw err
    logger.warn('fetchPayment after signature verify failed', { message: err.message })
  }

  if (order.status === 'PENDING_PAYMENT' || order.status === 'PAYMENT_FAILED') {
    const prevStatus = order.status
    order.status = 'PAYMENT_PROCESSING'
    order.statusHistory.push({
      previousStatus: prevStatus,
      status: 'PAYMENT_PROCESSING',
      source: 'SYSTEM',
      note: 'Client verification started',
      createdAt: new Date(),
    })
    await order.save()
  }

  const result = await confirmPaidOrder({
    order,
    razorpayPaymentId,
    razorpayOrderId,
    method,
    source: 'SYSTEM',
  })

  return {
    order: toCustomerOrder(result.order),
    alreadyConfirmed: result.alreadyConfirmed,
  }
}

export async function markPaymentFailed({ orderNumber, reason }) {
  const order = await Order.findOne({ orderNumber })
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  if (order.status === 'CONFIRMED' || order.payment?.status === 'CAPTURED') {
    return toCustomerOrder(order)
  }

  const prev = order.status
  order.status = 'PAYMENT_FAILED'
  order.payment = {
    ...(order.payment?.toObject?.() || order.payment || {}),
    status: 'FAILED',
    failedAt: new Date(),
    failureReason: reason || 'Payment failed',
  }
  order.paymentStatus = 'failed'
  order.statusHistory.push({
    previousStatus: prev,
    status: 'PAYMENT_FAILED',
    source: 'CUSTOMER',
    note: reason || 'Payment failed or dismissed',
    createdAt: new Date(),
  })
  await order.save()

  await PaymentAttempt.create({
    orderId: order._id,
    razorpayOrderId: order.payment?.razorpayOrderId,
    amountPaise: order.pricing?.totalPaise || 0,
    currency: 'INR',
    status: 'FAILED',
    failureDescription: reason || 'Payment failed',
  })

  return toCustomerOrder(order)
}

export async function processRazorpayWebhook(rawBody, signature) {
  razorpayService.verifyWebhookSignature(rawBody, signature)

  let payload
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    throw new ApiError(400, 'INVALID_WEBHOOK', 'Malformed webhook payload.')
  }

  const eventId = payload.event_id || payload.id || payload.payload?.payment?.entity?.id
  const eventType = payload.event
  if (!eventType) {
    throw new ApiError(400, 'INVALID_WEBHOOK', 'Missing event type.')
  }

  const stableId =
    eventId ||
    crypto
      .createHash('sha256')
      .update(rawBody)
      .digest('hex')

  try {
    await WebhookEvent.create({
      provider: 'razorpay',
      eventId: String(stableId),
      eventType,
      payloadHash: crypto.createHash('sha256').update(rawBody).digest('hex'),
      processedAt: null,
      rawSummary: { event: eventType },
    })
  } catch (err) {
    if (err?.code === 11000) {
      return { ok: true, duplicate: true }
    }
    throw err
  }

  try {
    if (
      eventType === 'payment.captured' ||
      eventType === 'order.paid'
    ) {
      const paymentEntity =
        payload.payload?.payment?.entity || payload.payload?.order?.entity
      const razorpayPaymentId =
        payload.payload?.payment?.entity?.id || null
      const razorpayOrderId =
        payload.payload?.payment?.entity?.order_id ||
        payload.payload?.order?.entity?.id ||
        null

      if (razorpayOrderId) {
        const order = await Order.findOne({ 'payment.razorpayOrderId': razorpayOrderId })
        if (order) {
          await confirmPaidOrder({
            order,
            razorpayPaymentId,
            razorpayOrderId,
            method: paymentEntity?.method || null,
            source: 'RAZORPAY_WEBHOOK',
          })
        }
      }
    }

    if (eventType === 'payment.failed') {
      const razorpayOrderId = payload.payload?.payment?.entity?.order_id
      if (razorpayOrderId) {
        const order = await Order.findOne({ 'payment.razorpayOrderId': razorpayOrderId })
        if (order && order.status !== 'CONFIRMED') {
          await markPaymentFailed({
            orderNumber: order.orderNumber,
            reason: payload.payload?.payment?.entity?.error_description || 'Payment failed',
          })
        }
      }
    }

    if (
      eventType === 'refund.processed' ||
      eventType === 'refund.failed'
    ) {
      logger.info('refund webhook received', { eventType })
      // Full refund state machine handled in refundService when implemented
    }

    await WebhookEvent.updateOne(
      { provider: 'razorpay', eventId: String(stableId) },
      { $set: { processedAt: new Date() } },
    )
  } catch (err) {
    logger.error('webhook processing error', { message: err.message, eventType })
    // Still return 200 after signature ok for unknown transient issues? Spec says return promptly.
    // Re-throw so Razorpay retries on our failures for confirmed processing errors.
    throw err
  }

  return { ok: true, duplicate: false }
}

export async function expireUnpaidOrders() {
  const now = new Date()
  const orders = await Order.find({
    status: { $in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
    paymentExpiresAt: { $lte: now },
  }).limit(100)

  let count = 0
  for (const order of orders) {
    await releaseReservations(order._id, 'EXPIRED')
    const prev = order.status
    order.status = 'PAYMENT_EXPIRED'
    order.statusHistory.push({
      previousStatus: prev,
      status: 'PAYMENT_EXPIRED',
      source: 'SYSTEM',
      note: 'Payment window expired',
      createdAt: new Date(),
    })
    await order.save()
    count += 1
  }
  return { expiredOrders: count }
}
