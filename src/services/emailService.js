import { Resend } from 'resend'
import { env, resendConfigured } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { formatPaiseInr, paiseToRupees } from '../utils/money.js'
import { Order } from '../models/Order.js'
import { buildTrackingUrl, issueEmailTrackingCode } from './orderTrackingService.js'

let resendClient = null

export function isResendReady() {
  return resendConfigured()
}

export function getResendClient() {
  if (!env.email.apiKey) return null
  if (!resendClient) {
    resendClient = new Resend(env.email.apiKey)
  }
  return resendClient
}

/** Test helper — reset singleton between tests. */
export function __resetResendClientForTests() {
  resendClient = null
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function resolveCustomerEmail(order) {
  return (
    order?.customerSnapshot?.email ||
    order?.customer?.email ||
    null
  )
}

function resolveCustomerName(order) {
  return (
    order?.customerSnapshot?.name ||
    order?.customer?.name ||
    order?.shippingAddress?.fullName ||
    'Customer'
  )
}

function paymentMethodLabel(order) {
  const method = String(order?.paymentMethod || 'PREPAID').toUpperCase()
  return method === 'COD' ? 'Cash on Delivery' : 'Prepaid'
}

function paymentStatusLabel(order) {
  const method = String(order?.paymentMethod || 'PREPAID').toUpperCase()
  if (method === 'COD') {
    const status = String(order?.paymentStatus || order?.payment?.status || '').toUpperCase()
    if (status === 'PAID' || status === 'CAPTURED') return 'Paid'
    return 'Payment Pending'
  }
  return 'Paid'
}

function formatAddress(order) {
  const a = order?.shippingAddress || {}
  const lines = [
    a.fullName || resolveCustomerName(order),
    a.addressLine1 || a.line1,
    a.addressLine2 || a.line2,
    a.landmark,
    [a.city, a.state, a.postalCode].filter(Boolean).join(', '),
    a.country || 'India',
  ].filter(Boolean)
  return lines.map(escapeHtml).join('<br/>')
}

function itemUnitPaise(item) {
  if (item.unitPricePaise != null) return Number(item.unitPricePaise)
  if (item.unitPrice != null) return Math.round(Number(item.unitPrice) * 100)
  return 0
}

function itemTotalPaise(item) {
  if (item.totalPaise != null) return Number(item.totalPaise)
  if (item.lineTotal != null) return Math.round(Number(item.lineTotal) * 100)
  return itemUnitPaise(item) * Number(item.quantity || 0)
}

function pricingFromOrder(order) {
  const p = order?.pricing || {}
  return {
    subtotalPaise: Number(p.subtotalPaise ?? 0),
    shippingPaise: Number(p.shippingPaise ?? 0),
    discountPaise: Number(p.discountPaise ?? 0),
    convenienceFeePaise: Number(p.convenienceFeePaise ?? 0),
    codFeePaise: Number(p.codFeePaise ?? 0),
    totalPaise: Number(p.totalPaise ?? 0),
  }
}

/**
 * Pure HTML builder — uses stored order pricing only (no recalculation).
 * Exported for unit tests.
 */
export function buildOrderConfirmationEmail(order, { trackingUrl } = {}) {
  const orderNumber = order?.orderNumber || ''
  const isCod = String(order?.paymentMethod || '').toUpperCase() === 'COD'
  const name = resolveCustomerName(order)
  const pricing = pricingFromOrder(order)
  const createdAt = order?.createdAt ? new Date(order.createdAt) : new Date()
  const dateLabel = createdAt.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const subject = `Scentinova — Order #${orderNumber} Confirmed`

  const items = Array.isArray(order?.items) ? order.items : []
  const itemRows = items
    .map((item) => {
      const img =
        item.image && /^https?:\/\//i.test(String(item.image))
          ? `<img src="${escapeHtml(item.image)}" alt="" width="48" height="48" style="display:block;border-radius:4px;object-fit:cover;border:1px solid #e8e4dc;" />`
          : ''
      return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #e8e4dc;vertical-align:top;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              ${img ? `<td style="padding-right:12px;vertical-align:top;">${img}</td>` : ''}
              <td style="vertical-align:top;">
                <div style="font-family:Georgia,serif;font-size:15px;color:#1b1917;">${escapeHtml(item.name)}</div>
                <div style="font-family:Arial,sans-serif;font-size:12px;color:#7a7368;margin-top:4px;">
                  Qty ${escapeHtml(item.quantity)} · ${escapeHtml(formatPaiseInr(itemUnitPaise(item)))} each
                </div>
              </td>
            </tr>
          </table>
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #e8e4dc;text-align:right;vertical-align:top;font-family:Arial,sans-serif;font-size:14px;color:#1b1917;white-space:nowrap;">
          ${escapeHtml(formatPaiseInr(itemTotalPaise(item)))}
        </td>
      </tr>`
    })
    .join('')

  const feeRows = [
    ['Subtotal', pricing.subtotalPaise],
    [
      'Shipping',
      pricing.shippingPaise,
      pricing.shippingPaise === 0 ? 'Complimentary' : null,
    ],
    ['Convenience Fee', pricing.convenienceFeePaise],
  ]

  if (isCod) {
    feeRows.push(['COD Fee', pricing.codFeePaise])
  }

  if (pricing.discountPaise > 0) {
    feeRows.push(['Discount', -pricing.discountPaise])
  }

  const feeHtml = feeRows
    .map(([label, paise, override]) => {
      const display =
        override != null
          ? override
          : formatPaiseInr(Math.abs(paise))
      const prefix = paise < 0 ? '−' : ''
      return `
      <tr>
        <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:13px;color:#7a7368;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;text-align:right;font-family:Arial,sans-serif;font-size:13px;color:#1b1917;">${prefix}${escapeHtml(display)}</td>
      </tr>`
    })
    .join('')

  const payableNote = isCod
    ? `<p style="margin:16px 0 0;padding:12px 14px;background:#f7f3ea;border:1px solid #e8e4dc;font-family:Arial,sans-serif;font-size:14px;color:#1b1917;">
         <strong>Amount payable on delivery:</strong> ${escapeHtml(formatPaiseInr(pricing.totalPaise))}
       </p>`
    : ''

  const safeTrackingUrl = trackingUrl && /^https?:\/\//i.test(trackingUrl) ? trackingUrl : null
  const trackingHtml = safeTrackingUrl
    ? `
          <tr>
            <td style="padding:4px 28px 24px;text-align:center;">
              <a href="${escapeHtml(safeTrackingUrl)}" style="display:inline-block;padding:13px 30px;background:#0d0c0b;color:#fffdf8;font-family:Arial,sans-serif;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;text-decoration:none;">Track your order</a>
              <div style="margin-top:12px;font-family:Arial,sans-serif;font-size:12px;color:#7a7368;">Or enter your order number <strong style="color:#1b1917;letter-spacing:0.04em;">${escapeHtml(orderNumber)}</strong> on our Track Order page.</div>
            </td>
          </tr>`
    : ''

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1ea;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fffdf8;border:1px solid #e8e4dc;">
          <tr>
            <td style="padding:28px 28px 12px;text-align:center;">
              <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.35em;color:#7a7368;text-transform:uppercase;">SCENTINOVA</div>
              <h1 style="margin:12px 0 0;font-family:Georgia,serif;font-size:28px;font-weight:normal;color:#1b1917;">Order confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 20px;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#4a453f;">
              Hello ${escapeHtml(name)},
              <br/>
              Thank you for your order. We have confirmed order <strong style="color:#1b1917;">#${escapeHtml(orderNumber)}</strong>
              placed on ${escapeHtml(dateLabel)}.
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f3ea;border:1px solid #e8e4dc;">
                <tr>
                  <td style="padding:14px 16px;font-family:Arial,sans-serif;font-size:13px;color:#4a453f;">
                    <div><strong style="color:#1b1917;">Status:</strong> ${escapeHtml(order?.status || 'CONFIRMED')}</div>
                    <div style="margin-top:6px;"><strong style="color:#1b1917;">Payment method:</strong> ${escapeHtml(paymentMethodLabel(order))}</div>
                    <div style="margin-top:6px;"><strong style="color:#1b1917;">Payment status:</strong> ${escapeHtml(paymentStatusLabel(order))}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>${trackingHtml}
          <tr>
            <td style="padding:0 28px 8px;">
              <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.28em;color:#7a7368;text-transform:uppercase;">Items</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
                ${itemRows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${feeHtml}
                <tr>
                  <td style="padding:14px 0 6px;border-top:1px solid #e8e4dc;font-family:Georgia,serif;font-size:18px;color:#1b1917;">Total</td>
                  <td style="padding:14px 0 6px;border-top:1px solid #e8e4dc;text-align:right;font-family:Georgia,serif;font-size:18px;color:#b4975a;">${escapeHtml(formatPaiseInr(pricing.totalPaise))}</td>
                </tr>
              </table>
              ${payableNote}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;">
              <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.28em;color:#7a7368;text-transform:uppercase;">Shipping address</div>
              <div style="margin-top:8px;font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#1b1917;">
                ${formatAddress(order)}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 28px;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#7a7368;border-top:1px solid #e8e4dc;">
              Questions about your order? Reply to this email or contact us at
              <a href="mailto:${escapeHtml(env.adminEmail || 'admin@scentinova.com')}" style="color:#b4975a;text-decoration:none;">${escapeHtml(env.adminEmail || 'admin@scentinova.com')}</a>.
              <br/>
              Thank you for choosing Scentinova.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const textLines = [
    'SCENTINOVA — Order confirmed',
    `Hello ${name},`,
    `Order #${orderNumber} confirmed (${dateLabel}).`,
    `Status: ${order?.status || 'CONFIRMED'}`,
    `Payment method: ${paymentMethodLabel(order)}`,
    `Payment status: ${paymentStatusLabel(order)}`,
    '',
    ...items.map(
      (item) =>
        `- ${item.name} x${item.quantity}: ${formatPaiseInr(itemTotalPaise(item))}`,
    ),
    '',
    `Subtotal: ${formatPaiseInr(pricing.subtotalPaise)}`,
    `Shipping: ${pricing.shippingPaise === 0 ? 'Complimentary' : formatPaiseInr(pricing.shippingPaise)}`,
    `Convenience Fee: ${formatPaiseInr(pricing.convenienceFeePaise)}`,
  ]
  if (isCod) {
    textLines.push(`COD Fee: ${formatPaiseInr(pricing.codFeePaise)}`)
  }
  if (pricing.discountPaise > 0) {
    textLines.push(`Discount: −${formatPaiseInr(pricing.discountPaise)}`)
  }
  textLines.push(`Total: ${formatPaiseInr(pricing.totalPaise)}`)
  if (isCod) {
    textLines.push(`Amount payable on delivery: ${formatPaiseInr(pricing.totalPaise)}`)
  }
  if (safeTrackingUrl) {
    textLines.push('', `Track your order: ${safeTrackingUrl}`)
  }

  return {
    subject,
    html,
    text: textLines.join('\n'),
    to: resolveCustomerEmail(order),
    isCod,
    pricing,
    display: {
      subtotal: paiseToRupees(pricing.subtotalPaise),
      convenienceFee: paiseToRupees(pricing.convenienceFeePaise),
      codFee: paiseToRupees(pricing.codFeePaise),
      total: paiseToRupees(pricing.totalPaise),
    },
  }
}

function fromAddress() {
  const from = String(env.email.from || '').trim()
  if (!from) return null
  if (from.includes('<')) return from
  return `Scentinova <${from}>`
}

/**
 * Send order confirmation via Resend.
 * Never throws to break order/payment flows — returns a result object.
 */
export async function sendOrderConfirmationEmail(orderInput) {
  const orderId = orderInput?._id || orderInput?.id
  let order = orderInput

  if (orderId) {
    const fresh = await Order.findById(orderId)
    if (fresh) order = fresh
  }

  if (!order) {
    return { sent: false, reason: 'order_missing' }
  }

  if (order.confirmationEmailSentAt || order.confirmationEmailStatus === 'sent') {
    logger.info('Order confirmation email skipped (already sent)', {
      orderNumber: order.orderNumber,
    })
    return {
      sent: false,
      reason: 'already_sent',
      messageId: order.confirmationEmailMessageId || null,
    }
  }

  const email = resolveCustomerEmail(order)
  if (!isValidEmail(email)) {
    logger.warn('Order confirmation email skipped (invalid customer email)', {
      orderNumber: order.orderNumber,
    })
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          confirmationEmailStatus: 'skipped',
          confirmationEmailLastError: 'invalid_or_missing_customer_email',
        },
      },
    ).catch(() => {})
    return { sent: false, reason: 'invalid_email' }
  }

  if (!isResendReady()) {
    logger.warn('Order confirmation email skipped (Resend not configured)', {
      orderNumber: order.orderNumber,
    })
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          confirmationEmailStatus: 'skipped',
          confirmationEmailLastError: 'resend_not_configured',
        },
      },
    ).catch(() => {})
    return { sent: false, reason: 'email_not_configured' }
  }

  const lockUntil = new Date(Date.now() + 90_000)
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      confirmationEmailSentAt: null,
      confirmationEmailStatus: { $nin: ['sent', 'sending'] },
    },
    {
      $set: {
        confirmationEmailStatus: 'sending',
        confirmationEmailLockUntil: lockUntil,
      },
    },
    { new: true },
  )

  // Allow retry when previous attempt failed or lock expired
  const claimedRetry =
    claimed ||
    (await Order.findOneAndUpdate(
      {
        _id: order._id,
        confirmationEmailSentAt: null,
        $or: [
          { confirmationEmailStatus: 'failed' },
          { confirmationEmailStatus: 'skipped' },
          {
            confirmationEmailStatus: 'sending',
            confirmationEmailLockUntil: { $lt: new Date() },
          },
        ],
      },
      {
        $set: {
          confirmationEmailStatus: 'sending',
          confirmationEmailLockUntil: lockUntil,
          confirmationEmailLastError: null,
        },
      },
      { new: true },
    ))

  if (!claimedRetry) {
    logger.info('Order confirmation email skipped (in progress or sent)', {
      orderNumber: order.orderNumber,
    })
    return { sent: false, reason: 'already_sent_or_in_progress' }
  }

  let tracking = {}
  try {
    const trackingCode = await issueEmailTrackingCode(claimedRetry)
    tracking = { trackingUrl: buildTrackingUrl(claimedRetry.orderNumber, trackingCode) }
  } catch (err) {
    logger.warn('Tracking code not issued; sending confirmation without link', {
      orderNumber: claimedRetry.orderNumber,
      reason: err?.message || 'unexpected_error',
    })
  }

  const content = buildOrderConfirmationEmail(claimedRetry, tracking)
  const idempotencyKey = `order-confirmation:${String(claimedRetry._id)}`

  try {
    const client = getResendClient()
    const { data, error } = await client.emails.send(
      {
        from: fromAddress(),
        to: [email.trim().toLowerCase()],
        subject: content.subject,
        html: content.html,
        text: content.text,
      },
      { idempotencyKey },
    )

    if (error) {
      const message = error?.message || 'resend_send_failed'
      logger.error('Order confirmation email failed', {
        orderNumber: claimedRetry.orderNumber,
        reason: message,
      })
      await Order.updateOne(
        { _id: claimedRetry._id, confirmationEmailSentAt: null },
        {
          $set: {
            confirmationEmailStatus: 'failed',
            confirmationEmailLastError: String(message).slice(0, 200),
          },
          $unset: { confirmationEmailLockUntil: '' },
        },
      ).catch(() => {})
      return { sent: false, reason: 'resend_error', error: message }
    }

    const messageId = data?.id || null
    await Order.updateOne(
      { _id: claimedRetry._id },
      {
        $set: {
          confirmationEmailSentAt: new Date(),
          confirmationEmailMessageId: messageId,
          confirmationEmailStatus: 'sent',
          confirmationEmailLastError: null,
        },
        $unset: { confirmationEmailLockUntil: '', pendingEmailTrackingCode: '' },
      },
    )

    logger.info('Order confirmation email sent', {
      orderNumber: claimedRetry.orderNumber,
      messageId,
    })

    return { sent: true, messageId, idempotencyKey }
  } catch (err) {
    logger.error('Order confirmation email failed', {
      orderNumber: claimedRetry.orderNumber,
      reason: err?.message || 'unexpected_error',
    })
    await Order.updateOne(
      { _id: claimedRetry._id, confirmationEmailSentAt: null },
      {
        $set: {
          confirmationEmailStatus: 'failed',
          confirmationEmailLastError: String(err?.message || 'unexpected_error').slice(
            0,
            200,
          ),
        },
        $unset: { confirmationEmailLockUntil: '' },
      },
    ).catch(() => {})
    return { sent: false, reason: 'exception', error: err?.message }
  }
}

/**
 * Fire-and-forget safe wrapper — never rejects.
 */
export async function sendOrderConfirmationEmailSafe(order) {
  try {
    return await sendOrderConfirmationEmail(order)
  } catch (err) {
    logger.error('Order confirmation email unexpected failure', {
      orderNumber: order?.orderNumber,
      reason: err?.message || 'unexpected_error',
    })
    return { sent: false, reason: 'exception', error: err?.message }
  }
}

/**
 * Notification abstraction — ORDER_CONFIRMED triggers Resend email.
 * Other events remain structured logs until templates are added.
 */
export async function notify(event, payload = {}) {
  logger.info('notification', { event, ...summarize(payload) })

  if (event === NotificationEvent.ORDER_CONFIRMED && payload.order) {
    return sendOrderConfirmationEmailSafe(payload.order)
  }

  if (event === NotificationEvent.ORDER_CONFIRMED && payload.orderNumber) {
    const order = await Order.findOne({ orderNumber: payload.orderNumber })
    if (order) return sendOrderConfirmationEmailSafe(order)
  }

  if (!isResendReady()) {
    return { sent: false, reason: 'email_not_configured' }
  }

  // Future: ORDER_SHIPPED / DELIVERED / etc.
  return { sent: false, reason: 'event_not_implemented' }
}

function summarize(payload) {
  return {
    orderNumber: payload.orderNumber,
    // Avoid logging full PII in production-heavy paths; keep domain-only hint
    emailDomain: payload.email?.includes('@')
      ? payload.email.split('@')[1]
      : undefined,
    paymentMethod: payload.paymentMethod,
    paymentStatus: payload.paymentStatus,
    codFee:
      payload.codFeePaise != null ? formatPaiseInr(payload.codFeePaise) : undefined,
    convenienceFee:
      payload.convenienceFeePaise != null
        ? formatPaiseInr(payload.convenienceFeePaise)
        : undefined,
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
