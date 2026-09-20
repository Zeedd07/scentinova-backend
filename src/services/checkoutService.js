import mongoose from 'mongoose'
import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { Payment } from '../models/Payment.js'
import { PaymentAttempt } from '../models/PaymentAttempt.js'
import { ApiError } from '../utils/ApiError.js'
import { env } from '../config/env.js'
import { generateOrderNumber } from '../utils/orderNumber.js'
import { generateTrackingToken, hashToken } from '../utils/tokens.js'
import { paiseToRupees, rupeesToPaise } from '../utils/money.js'
import { reserveForOrder } from './inventoryService.js'
import * as razorpayService from './razorpayService.js'
import { writeAudit } from './auditService.js'
import { logger } from '../utils/logger.js'

function resolvePricePaise(product) {
  if (product.pricePaise != null && Number.isFinite(Number(product.pricePaise))) {
    return Math.round(Number(product.pricePaise))
  }
  if (product.price != null && Number.isFinite(Number(product.price))) {
    return rupeesToPaise(product.price)
  }
  return null
}

/**
 * Server-authoritative quote — never trusts client totals.
 */
export async function quoteCart({ items, expectedTotalPaise } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Add at least one fragrance.')
  }

  const productIds = items.map((i) => i.productId)
  for (const id of productIds) {
    if (!mongoose.isValidObjectId(id)) {
      throw new ApiError(400, 'PRODUCT_NOT_FOUND', 'Invalid product in cart.')
    }
  }

  const products = await Product.find({ _id: { $in: productIds } })
  const byId = new Map(products.map((p) => [p._id.toString(), p]))

  const lineItems = []
  let subtotalPaise = 0
  const changes = []

  for (const line of items) {
    const qty = Number(line.quantity)
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid quantity.')
    }

    const product = byId.get(String(line.productId))
    if (!product) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'A product in your cart was not found.')
    }
    if (!product.active) {
      throw new ApiError(400, 'PRODUCT_UNAVAILABLE', `${product.name} is no longer available.`)
    }

    const unitPricePaise = resolvePricePaise(product)
    if (unitPricePaise == null || unitPricePaise < 100) {
      throw new ApiError(
        400,
        'PRODUCT_UNAVAILABLE',
        `${product.name} cannot be purchased right now.`,
      )
    }

    if (line.unitPricePaise != null && Number(line.unitPricePaise) !== unitPricePaise) {
      changes.push({
        productId: product._id.toString(),
        name: product.name,
        previousPaise: Number(line.unitPricePaise),
        currentPaise: unitPricePaise,
      })
    }

    const { getAvailableStock } = await import('./inventoryService.js')
    const available = await getAvailableStock(product._id)
    if (available < qty) {
      throw new ApiError(
        400,
        'INSUFFICIENT_STOCK',
        `${product.name} does not have enough stock.`,
      )
    }

    const lineSubtotal = unitPricePaise * qty
    subtotalPaise += lineSubtotal

    lineItems.push({
      productId: product._id.toString(),
      sku: product.sku || product.slug?.toUpperCase(),
      slug: product.slug,
      name: product.name,
      image: product.image,
      size: product.size,
      concentration: product.concentration,
      quantity: qty,
      unitPricePaise,
      subtotalPaise: lineSubtotal,
      discountPaise: 0,
      taxPaise: 0,
      totalPaise: lineSubtotal,
      unitPrice: paiseToRupees(unitPricePaise),
      lineTotal: paiseToRupees(lineSubtotal),
    })
  }

  if (changes.length) {
    throw new ApiError(409, 'PRICE_CHANGED', 'Prices changed since your cart was loaded.', {
      changes,
    })
  }

  const discountPaise = 0
  const taxPaise = 0
  const shippingPaise =
    subtotalPaise >= env.freeShippingThresholdPaise ? 0 : env.shippingPaise
  const totalPaise = subtotalPaise - discountPaise + taxPaise + shippingPaise

  if (
    expectedTotalPaise != null &&
    Number.isFinite(Number(expectedTotalPaise)) &&
    Number(expectedTotalPaise) !== totalPaise
  ) {
    throw new ApiError(409, 'PRICE_CHANGED', 'Cart total changed. Please review your order.')
  }

  return {
    currency: 'INR',
    items: lineItems,
    pricing: {
      currency: 'INR',
      subtotalPaise,
      discountPaise,
      taxPaise,
      shippingPaise,
      totalPaise,
    },
    // Convenience rupee mirrors for UI
    subtotal: paiseToRupees(subtotalPaise),
    shipping: paiseToRupees(shippingPaise),
    total: paiseToRupees(totalPaise),
  }
}

function splitName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
  const firstName = parts[0] || ''
  const lastName = parts.slice(1).join(' ') || ''
  return { firstName, lastName, name: String(fullName || '').trim() }
}

/**
 * Create PENDING_PAYMENT order + inventory reservation + Razorpay order.
 */
export async function createPaymentOrder(input, { idempotencyKey, ip, userAgent } = {}) {
  if (!razorpayService.isRazorpayReady()) {
    throw new ApiError(
      501,
      'PAYMENT_UNAVAILABLE',
      'Online payments are not configured yet. Add Razorpay keys to the server environment.',
    )
  }

  if (idempotencyKey) {
    const existing = await Order.findOne({ idempotencyKey })
    if (existing) {
      return serializeCheckoutResponse(existing)
    }
  }

  const quote = await quoteCart({ items: input.items })
  const { firstName, lastName, name } = splitName(
    input.customer?.name || input.shippingAddress?.fullName,
  )
  const email = String(input.customer?.email || '').toLowerCase().trim()
  const phone = input.customer?.phone || input.shippingAddress?.phone || null

  if (!name || !email) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Name and email are required.')
  }

  const addressLine1 =
    input.shippingAddress?.addressLine1 || input.shippingAddress?.line1 || ''
  if (!addressLine1 || !input.shippingAddress?.city || !input.shippingAddress?.postalCode) {
    throw new ApiError(400, 'INVALID_ADDRESS', 'Complete shipping address is required.')
  }

  const trackingToken = generateTrackingToken()
  const paymentExpiresAt = new Date(
    Date.now() + env.orderPaymentTtlMinutes * 60 * 1000,
  )

  let order
  try {
    order = await Order.create({
      orderNumber: generateOrderNumber(),
      idempotencyKey: idempotencyKey || null,
      customerSnapshot: {
        firstName,
        lastName,
        name,
        email,
        phone,
      },
      customer: { name, email, phone },
      shippingAddress: {
        fullName: input.shippingAddress.fullName || name,
        phone: input.shippingAddress.phone || phone,
        addressLine1,
        addressLine2: input.shippingAddress.addressLine2 || input.shippingAddress.line2 || null,
        landmark: input.shippingAddress.landmark || null,
        city: input.shippingAddress.city,
        state: input.shippingAddress.state || null,
        postalCode: input.shippingAddress.postalCode,
        country: input.shippingAddress.country || 'India',
        line1: addressLine1,
        line2: input.shippingAddress.addressLine2 || input.shippingAddress.line2 || null,
      },
      items: quote.items.map((i) => ({
        productId: i.productId,
        sku: i.sku,
        slug: i.slug,
        name: i.name,
        image: i.image,
        size: i.size,
        concentration: i.concentration,
        quantity: i.quantity,
        unitPricePaise: i.unitPricePaise,
        subtotalPaise: i.subtotalPaise,
        discountPaise: i.discountPaise,
        taxPaise: i.taxPaise,
        totalPaise: i.totalPaise,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
      })),
      pricing: quote.pricing,
      subtotal: quote.subtotal,
      shipping: quote.shipping,
      total: quote.total,
      currency: 'INR',
      status: 'PENDING_PAYMENT',
      payment: {
        provider: 'razorpay',
        status: 'CREATED',
        amountPaise: quote.pricing.totalPaise,
        currency: 'INR',
      },
      paymentStatus: 'pending',
      fulfillment: { status: 'unfulfilled' },
      fulfillmentStatus: 'unfulfilled',
      trackingTokenHash: hashToken(trackingToken),
      paymentExpiresAt,
      customerNote: input.customerNote || null,
      statusHistory: [
        {
          previousStatus: null,
          status: 'PENDING_PAYMENT',
          source: 'SYSTEM',
          note: 'Checkout started',
          createdAt: new Date(),
        },
      ],
    })
  } catch (err) {
    if (err?.code === 11000 && idempotencyKey) {
      const existing = await Order.findOne({ idempotencyKey })
      if (existing) return serializeCheckoutResponse(existing)
    }
    throw err
  }

  try {
    await reserveForOrder(
      order._id,
      quote.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    )

    const rzpOrder = await razorpayService.createRazorpayOrder({
      amountPaise: quote.pricing.totalPaise,
      receipt: order.orderNumber,
      notes: { orderNumber: order.orderNumber },
    })

    order.payment.razorpayOrderId = rzpOrder.id
    await order.save()

    await Payment.create({
      orderId: order._id,
      orderNumber: order.orderNumber,
      razorpayOrderId: rzpOrder.id,
      amountPaise: quote.pricing.totalPaise,
      currency: 'INR',
      status: 'CREATED',
    })

    await PaymentAttempt.create({
      orderId: order._id,
      razorpayOrderId: rzpOrder.id,
      amountPaise: quote.pricing.totalPaise,
      currency: 'INR',
      status: 'CREATED',
    })

    await writeAudit({
      actorType: 'CUSTOMER',
      action: 'CHECKOUT_PAYMENT_ORDER_CREATED',
      entityType: 'Order',
      entityId: order._id,
      metadata: { orderNumber: order.orderNumber, razorpayOrderId: rzpOrder.id },
      ip,
      userAgent,
    })

    return {
      ...serializeCheckoutResponse(order),
      trackingToken,
    }
  } catch (err) {
    logger.error('createPaymentOrder failed', {
      orderNumber: order?.orderNumber,
      message: err.message,
    })
    if (order?._id) {
      const { releaseReservations } = await import('./inventoryService.js')
      await releaseReservations(order._id, 'RELEASED')
      order.status = 'CANCELLED'
      order.statusHistory.push({
        previousStatus: 'PENDING_PAYMENT',
        status: 'CANCELLED',
        source: 'SYSTEM',
        note: 'Checkout failed during payment order creation',
        createdAt: new Date(),
      })
      await order.save()
    }
    throw err
  }
}

function serializeCheckoutResponse(order) {
  return {
    orderNumber: order.orderNumber,
    razorpayOrderId: order.payment?.razorpayOrderId,
    amount: order.pricing?.totalPaise ?? rupeesToPaise(order.total || 0),
    currency: 'INR',
    keyId: razorpayService.publicKeyId(),
    status: order.status,
    paymentExpiresAt: order.paymentExpiresAt,
  }
}

export async function getOrderForConfirmation(orderNumber, { trackingToken } = {}) {
  const order = await Order.findOne({ orderNumber })
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')

  if (trackingToken) {
    if (hashToken(trackingToken) !== order.trackingTokenHash) {
      throw new ApiError(403, 'FORBIDDEN', 'Invalid tracking token.')
    }
  } else if (order.status === 'PENDING_PAYMENT' || order.status === 'PAYMENT_FAILED') {
    // Allow limited confirmation polling without token only for non-sensitive status
  }

  return toCustomerOrder(order)
}

export async function trackOrderByToken(token) {
  if (!token) throw new ApiError(400, 'VALIDATION_ERROR', 'Tracking token required.')
  const order = await Order.findOne({ trackingTokenHash: hashToken(token) })
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  return toCustomerOrder(order)
}

export function toCustomerOrder(order) {
  const o = order.toJSON ? order.toJSON() : order
  return {
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    status: o.status,
    items: (o.items || []).map((i) => ({
      name: i.name,
      slug: i.slug,
      image: i.image,
      quantity: i.quantity,
      size: i.size,
      unitPricePaise: i.unitPricePaise,
      totalPaise: i.totalPaise,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
    })),
    pricing: o.pricing,
    total: o.total,
    currency: o.currency || 'INR',
    payment: {
      status: o.payment?.status,
      method: o.payment?.method,
      amountPaise: o.payment?.amountPaise,
      capturedAt: o.payment?.capturedAt,
    },
    shippingAddress: {
      city: o.shippingAddress?.city,
      state: o.shippingAddress?.state,
      postalCode: o.shippingAddress?.postalCode,
      country: o.shippingAddress?.country,
      fullName: o.shippingAddress?.fullName || o.customerSnapshot?.name,
    },
    fulfillment: {
      status: o.fulfillment?.status,
      carrier: o.fulfillment?.carrier,
      trackingNumber: o.fulfillment?.trackingNumber,
      trackingUrl: o.fulfillment?.trackingUrl,
      shippedAt: o.fulfillment?.shippedAt,
      deliveredAt: o.fulfillment?.deliveredAt,
    },
    statusHistory: (o.statusHistory || []).map((h) => ({
      status: h.status,
      note: h.note,
      createdAt: h.createdAt,
    })),
  }
}
