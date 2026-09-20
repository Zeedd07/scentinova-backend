import crypto from 'crypto'
import { getRazorpay, getRazorpayKeyId, razorpayConfigured } from '../config/razorpay.js'
import { env } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { assertChargeablePaise } from '../utils/money.js'

export function isRazorpayReady() {
  return razorpayConfigured()
}

export async function createRazorpayOrder({ amountPaise, receipt, notes = {} }) {
  const amount = assertChargeablePaise(amountPaise)
  const rzp = getRazorpay()
  const order = await rzp.orders.create({
    amount,
    currency: 'INR',
    receipt: String(receipt).slice(0, 40),
    notes,
  })
  return order
}

export function verifyPaymentSignature({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) {
  if (!env.razorpay.keySecret) {
    throw new ApiError(501, 'PAYMENT_UNAVAILABLE', 'Razorpay is not configured.')
  }
  const body = `${razorpayOrderId}|${razorpayPaymentId}`
  const expected = crypto
    .createHmac('sha256', env.razorpay.keySecret)
    .update(body)
    .digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(String(razorpaySignature || ''))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(
      400,
      'PAYMENT_VERIFICATION_FAILED',
      'Payment signature verification failed.',
    )
  }
  return true
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!env.razorpay.webhookSecret) {
    throw new ApiError(501, 'PAYMENT_UNAVAILABLE', 'Webhook secret is not configured.')
  }
  const expected = crypto
    .createHmac('sha256', env.razorpay.webhookSecret)
    .update(rawBody)
    .digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(String(signature || ''))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(400, 'INVALID_WEBHOOK', 'Invalid webhook signature.')
  }
  return true
}

export async function fetchPayment(paymentId) {
  const rzp = getRazorpay()
  return rzp.payments.fetch(paymentId)
}

export async function createRefund({ paymentId, amountPaise, notes = {} }) {
  const rzp = getRazorpay()
  return rzp.payments.refund(paymentId, {
    amount: amountPaise,
    notes,
  })
}

export function publicKeyId() {
  return getRazorpayKeyId()
}
