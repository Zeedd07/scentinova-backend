import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { formatPaiseInr } from '../utils/money.js'

/**
 * Notification abstraction — logs in development; wire EMAIL_* for production.
 */
export async function notify(event, payload = {}) {
  logger.info('notification', { event, ...summarize(payload) })

  if (!env.email.provider || !env.email.apiKey) {
    return { sent: false, reason: 'email_not_configured' }
  }

  // Provider-specific integration can be plugged here (Resend/SendGrid/etc.).
  // Intentionally no fake "sent: true" without a real provider call.
  return { sent: false, reason: 'provider_not_implemented' }
}

function summarize(payload) {
  return {
    orderNumber: payload.orderNumber,
    email: payload.email,
    total: payload.totalPaise != null ? formatPaiseInr(payload.totalPaise) : undefined,
    status: payload.status,
  }
}

export const NotificationEvent = {
  PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_SHIPPED: 'ORDER_SHIPPED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  ORDER_DELIVERED: 'ORDER_DELIVERED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  REFUND_INITIATED: 'REFUND_INITIATED',
  REFUND_COMPLETED: 'REFUND_COMPLETED',
}
