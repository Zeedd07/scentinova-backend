import mongoose from 'mongoose'
import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { Payment } from '../models/Payment.js'
import { PaymentAttempt } from '../models/PaymentAttempt.js'
import { ApiError } from '../utils/ApiError.js'
import { resolveIndiaAddress } from '../utils/indiaLocations.js'
import { env } from '../config/env.js'
import { generateOrderNumber } from '../utils/orderNumber.js'
import { generateTrackingToken, hashToken } from '../utils/tokens.js'
import { paiseToRupees, rupeesToPaise } from '../utils/money.js'
import {
  PAYMENT_METHODS,
  assertPaymentMethodAllowed,
  calculateCheckoutPricing,
  computePaymentOptions,
  normalizePaymentMethod,
  requiresRazorpay,
} from '../utils/pricing.js'
import { reserveForOrder, commitReservations } from './inventoryService.js'
import * as razorpayService from './razorpayService.js'
import { writeAudit } from './auditService.js'
import { sendOrderConfirmationEmailSafe } from './emailService.js'
import { tokenMatchesOrder } from './orderTrackingService.js'
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

function orderPricing(breakdown) {
  return {
    currency: 'INR',
    subtotalPaise: breakdown.subtotalPaise,
    discountPaise: breakdown.discountPaise,
    taxPaise: breakdown.taxPaise,
    shippingPaise: breakdown.shippingPaise,
    codFeePaise: breakdown.codFeePaise,
    convenienceFeePaise: breakdown.convenienceFeePaise,
    totalPaise: breakdown.totalPaise,
    configVersion: breakdown.configVersion,
  }
}

function feeLine(product) {
  return { productId: product._id.toString(), name: product.name, fees: product.fees }
}

/**
 * Re-price an existing order's items with the current product prices and fees.
 * Used to decide whether an idempotent retry may reuse a pending order.
 */
async function currentTotalForOrder(order) {
  const ids = (order.items || []).map((i) => i.productId)
  const products = await Product.find({ _id: { $in: ids } })
  const byId = new Map(products.map((p) => [p._id.toString(), p]))
  let subtotalPaise = 0
  const lines = []
  for (const item of order.items || []) {
    const product = byId.get(String(item.productId))
    const unitPricePaise = product?.active ? resolvePricePaise(product) : null
    if (unitPricePaise == null) return null
    subtotalPaise += unitPricePaise * item.quantity
    lines.push(feeLine(product))
  }
  if (!lines.length) return null
  return calculateCheckoutPricing({
    subtotalPaise,
    paymentMethod: order.paymentMethod,
    lines,
  }).totalPaise
}

/**
 * Cart-independent checkout options. Fees are configured per product and returned by
 * quoteCart as `paymentOptions`; this stays for clients that still call /checkout/options.
 */
export function getCheckoutOptions() {
  return {
    version: null,
    paymentMethods: {
      prepaid: { enabled: true, convenienceFeePaise: 0 },
      cod: { enabled: true, codFeePaise: 0, convenienceFeePaise: 0 },
    },
    shipping: { enabled: false, standardFeePaise: 0, freeShippingThresholdPaise: null },
  }
}

/**
 * Server-authoritative quote — never trusts client totals or fees.
 * Only `items`, `paymentMethod` and `expectedTotalPaise` are read from input;
 * fees come from the Product documents.
 */
export async function quoteCart({
  items,
  expectedTotalPaise,
  paymentMethod = PAYMENT_METHODS.PREPAID,
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Add at least one fragrance.')
  }

  const method = normalizePaymentMethod(paymentMethod)

  const productIds = items.map((i) => i.productId)
  for (const id of productIds) {
    if (!mongoose.isValidObjectId(id)) {
      throw new ApiError(400, 'PRODUCT_NOT_FOUND', 'Invalid product in cart.')
    }
  }

  const products = await Product.find({ _id: { $in: productIds } })
  const byId = new Map(products.map((p) => [p._id.toString(), p]))

  const lineItems = []
  const feeLines = []
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
    feeLines.push(feeLine(product))

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

  assertPaymentMethodAllowed(feeLines, method)

  const breakdown = calculateCheckoutPricing({
    subtotalPaise,
    discountPaise: 0,
    taxPaise: 0,
    paymentMethod: method,
    lines: feeLines,
  })

  if (
    expectedTotalPaise != null &&
    Number.isFinite(Number(expectedTotalPaise)) &&
    Number(expectedTotalPaise) !== breakdown.totalPaise
  ) {
    throw new ApiError(409, 'PRICE_CHANGED', 'Cart total changed. Please review your order.')
  }

  return {
    currency: 'INR',
    paymentMethod: method,
    items: lineItems,
    pricing: orderPricing(breakdown),
    pricingSnapshot: breakdown.pricingSnapshot,
    paymentOptions: computePaymentOptions(feeLines),
    subtotalPaise: breakdown.subtotalPaise,
    discountPaise: breakdown.discountPaise,
    shippingPaise: breakdown.shippingPaise,
    convenienceFeePaise: breakdown.convenienceFeePaise,
    codFeePaise: breakdown.codFeePaise,
    totalPaise: breakdown.totalPaise,
    subtotal: breakdown.subtotal,
    shipping: breakdown.shipping,
    discount: breakdown.discount,
    codFee: breakdown.codFee,
    convenienceFee: breakdown.convenienceFee,
    total: breakdown.total,
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

function buildCustomerAndAddress(input) {
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

  const location = resolveIndiaAddress(input.shippingAddress)

  return {
    firstName,
    lastName,
    name,
    email,
    phone,
    shippingAddress: {
      fullName: input.shippingAddress.fullName || name,
      phone: input.shippingAddress.phone || phone,
      addressLine1,
      addressLine2: input.shippingAddress.addressLine2 || input.shippingAddress.line2 || null,
      landmark: input.shippingAddress.landmark || null,
      city: location.city,
      state: location.state,
      postalCode: input.shippingAddress.postalCode,
      country: location.country,
      line1: addressLine1,
      line2: input.shippingAddress.addressLine2 || input.shippingAddress.line2 || null,
    },
  }
}

function orderItemsFromQuote(quote) {
  return quote.items.map((i) => ({
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
  }))
}

async function releaseIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return
  const existing = await Order.findOne({ idempotencyKey })
  if (!existing) return null
  return existing
}

/**
 * Create checkout order — PREPAID (Razorpay) or COD (no Razorpay).
 */
export async function createPaymentOrder(input, { idempotencyKey, ip, userAgent } = {}) {
  const paymentMethod = normalizePaymentMethod(input.paymentMethod)
  if (paymentMethod === PAYMENT_METHODS.COD) {
    return createCodOrder(input, { idempotencyKey, ip, userAgent })
  }
  return createPrepaidOrder(input, { idempotencyKey, ip, userAgent })
}

async function createPrepaidOrder(input, { idempotencyKey, ip, userAgent } = {}) {
  if (!razorpayService.isRazorpayReady()) {
    throw new ApiError(
      501,
      'PAYMENT_UNAVAILABLE',
      'Online payments are not configured yet. Add Razorpay keys to the server environment.',
    )
  }

  if (idempotencyKey) {
    const existing = await releaseIdempotencyKey(idempotencyKey)
    if (existing) {
      // Reuse the pending order only while its total still matches current product prices and fees
      if (
        existing.status === 'PENDING_PAYMENT' &&
        existing.paymentMethod !== PAYMENT_METHODS.COD &&
        existing.payment?.razorpayOrderId &&
        (await currentTotalForOrder(existing)) === existing.pricing?.totalPaise
      ) {
        return serializeCheckoutResponse(existing)
      }
      await Order.updateOne({ _id: existing._id }, { $unset: { idempotencyKey: '' } })
    }
  }

  // Pricing moment = order creation
  const quote = await quoteCart({ items: input.items, paymentMethod: PAYMENT_METHODS.PREPAID })
  const customer = buildCustomerAndAddress(input)
  const trackingToken = generateTrackingToken()
  const paymentExpiresAt = new Date(
    Date.now() + env.orderPaymentTtlMinutes * 60 * 1000,
  )

  let order
  try {
    order = await Order.create({
      orderNumber: generateOrderNumber(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      paymentMethod: PAYMENT_METHODS.PREPAID,
      customerSnapshot: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
      customer: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
      shippingAddress: customer.shippingAddress,
      items: orderItemsFromQuote(quote),
      pricing: quote.pricing,
      pricingSnapshot: quote.pricingSnapshot,
      subtotal: quote.subtotal,
      shipping: quote.shipping,
      discount: quote.discount,
      codFee: quote.codFee,
      convenienceFee: quote.convenienceFee,
      total: quote.total,
      currency: 'INR',
      status: 'PENDING_PAYMENT',
      payment: {
        provider: 'razorpay',
        status: 'CREATED',
        amountPaise: quote.pricing.totalPaise,
        currency: 'INR',
      },
      paymentStatus: 'PENDING',
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
          note: 'Prepaid checkout started',
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
      notes: { orderNumber: order.orderNumber, paymentMethod: 'PREPAID' },
    })

    order.payment.razorpayOrderId = rzpOrder.id
    try {
      await order.save()
    } catch (saveErr) {
      if (saveErr?.code === 11000) {
        if (idempotencyKey) {
          const byKey = await Order.findOne({ idempotencyKey })
          if (byKey) return serializeCheckoutResponse(byKey)
        }
        const byRzp = await Order.findOne({ 'payment.razorpayOrderId': rzpOrder.id })
        if (byRzp) return serializeCheckoutResponse(byRzp)
      }
      throw saveErr
    }

    try {
      await Payment.create({
        orderId: order._id,
        orderNumber: order.orderNumber,
        provider: 'razorpay',
        razorpayOrderId: rzpOrder.id,
        amountPaise: quote.pricing.totalPaise,
        currency: 'INR',
        status: 'CREATED',
      })
    } catch (payErr) {
      if (payErr?.code !== 11000) throw payErr
    }

    try {
      await PaymentAttempt.create({
        orderId: order._id,
        razorpayOrderId: rzpOrder.id,
        amountPaise: quote.pricing.totalPaise,
        currency: 'INR',
        status: 'CREATED',
      })
    } catch (attemptErr) {
      if (attemptErr?.code !== 11000) throw attemptErr
    }

    await writeAudit({
      actorType: 'CUSTOMER',
      action: 'CHECKOUT_PAYMENT_ORDER_CREATED',
      entityType: 'Order',
      entityId: order._id,
      metadata: {
        orderNumber: order.orderNumber,
        razorpayOrderId: rzpOrder.id,
        paymentMethod: PAYMENT_METHODS.PREPAID,
        totalPaise: quote.pricing.totalPaise,
      },
      ip,
      userAgent,
    })

    return {
      ...serializeCheckoutResponse(order),
      trackingToken,
    }
  } catch (err) {
    if (err?.code === 11000 && idempotencyKey) {
      const existing = await Order.findOne({ idempotencyKey })
      if (existing) return serializeCheckoutResponse(existing)
    }
    logger.error('createPrepaidOrder failed', {
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

async function createCodOrder(input, { idempotencyKey, ip, userAgent } = {}) {
  if (idempotencyKey) {
    const existing = await releaseIdempotencyKey(idempotencyKey)
    if (existing) {
      if (
        existing.paymentMethod === PAYMENT_METHODS.COD &&
        existing.status === 'CONFIRMED' &&
        !existing.payment?.razorpayOrderId
      ) {
        return {
          ...serializeCodCheckoutResponse(existing),
        }
      }
      await Order.updateOne({ _id: existing._id }, { $unset: { idempotencyKey: '' } })
    }
  }

  // A duplicate submit of an already-placed COD order is returned above; new COD
  // orders require every product to allow COD right now (checked in quoteCart).
  const quote = await quoteCart({ items: input.items, paymentMethod: PAYMENT_METHODS.COD })
  const customer = buildCustomerAndAddress(input)
  const trackingToken = generateTrackingToken()

  let order
  try {
    order = await Order.create({
      orderNumber: generateOrderNumber(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      paymentMethod: PAYMENT_METHODS.COD,
      customerSnapshot: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
      customer: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
      shippingAddress: customer.shippingAddress,
      items: orderItemsFromQuote(quote),
      pricing: quote.pricing,
      pricingSnapshot: quote.pricingSnapshot,
      subtotal: quote.subtotal,
      shipping: quote.shipping,
      discount: quote.discount,
      codFee: quote.codFee,
      convenienceFee: quote.convenienceFee,
      total: quote.total,
      currency: 'INR',
      status: 'CONFIRMED',
      payment: {
        provider: 'cod',
        status: 'PENDING',
        method: 'COD',
        amountPaise: quote.pricing.totalPaise,
        currency: 'INR',
      },
      paymentStatus: 'PENDING',
      fulfillment: { status: 'unfulfilled' },
      fulfillmentStatus: 'unfulfilled',
      trackingTokenHash: hashToken(trackingToken),
      paymentExpiresAt: null,
      customerNote: input.customerNote || null,
      statusHistory: [
        {
          previousStatus: null,
          status: 'CONFIRMED',
          source: 'SYSTEM',
          note: 'COD order placed — payment due on delivery',
          createdAt: new Date(),
        },
      ],
    })
  } catch (err) {
    if (err?.code === 11000 && idempotencyKey) {
      const existing = await Order.findOne({ idempotencyKey })
      // This token was never persisted on `existing`, so returning it would not work
      if (existing) return serializeCodCheckoutResponse(existing)
    }
    throw err
  }

  try {
    await reserveForOrder(
      order._id,
      quote.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    )
    await commitReservations(order._id)
    order.inventoryCommitted = true
    order.stockDecremented = true
    await order.save()

    try {
      await Payment.create({
        orderId: order._id,
        orderNumber: order.orderNumber,
        provider: 'cod',
        amountPaise: quote.pricing.totalPaise,
        currency: 'INR',
        status: 'PENDING',
        method: 'COD',
      })
    } catch (payErr) {
      if (payErr?.code !== 11000) throw payErr
    }

    await writeAudit({
      actorType: 'CUSTOMER',
      action: 'CHECKOUT_COD_ORDER_CREATED',
      entityType: 'Order',
      entityId: order._id,
      metadata: {
        orderNumber: order.orderNumber,
        paymentMethod: PAYMENT_METHODS.COD,
        totalPaise: quote.pricing.totalPaise,
        codFeePaise: quote.pricing.codFeePaise,
        convenienceFeePaise: quote.pricing.convenienceFeePaise,
      },
      ip,
      userAgent,
    })
  } catch (err) {
    logger.error('createCodOrder failed', {
      orderNumber: order?.orderNumber,
      message: err.message,
    })
    if (order?._id) {
      const { releaseReservations } = await import('./inventoryService.js')
      await releaseReservations(order._id, 'RELEASED')
      order.status = 'CANCELLED'
      order.paymentStatus = 'FAILED'
      order.payment = {
        ...(order.payment?.toObject?.() || order.payment || {}),
        status: 'FAILED',
        failedAt: new Date(),
        failureReason: 'COD checkout failed',
      }
      order.statusHistory.push({
        previousStatus: 'CONFIRMED',
        status: 'CANCELLED',
        source: 'SYSTEM',
        note: 'COD checkout failed during inventory commit',
        createdAt: new Date(),
      })
      await order.save()
    }
    throw err
  }

  // Outside inventory try/catch — email must never cancel a successful COD order
  await sendOrderConfirmationEmailSafe(order)

  return {
    ...serializeCodCheckoutResponse(order),
    trackingToken,
  }
}

function serializeCheckoutResponse(order) {
  return {
    orderNumber: order.orderNumber,
    paymentMethod: order.paymentMethod || PAYMENT_METHODS.PREPAID,
    paymentStatus: order.paymentStatus || order.payment?.status || 'PENDING',
    razorpayOrderId: order.payment?.razorpayOrderId,
    amount: order.pricing?.totalPaise ?? rupeesToPaise(order.total || 0),
    currency: 'INR',
    keyId: razorpayService.publicKeyId(),
    status: order.status,
    paymentExpiresAt: order.paymentExpiresAt,
    pricing: order.pricing,
    requiresRazorpay: requiresRazorpay(order.paymentMethod || PAYMENT_METHODS.PREPAID),
  }
}

function serializeCodCheckoutResponse(order) {
  return {
    orderNumber: order.orderNumber,
    paymentMethod: PAYMENT_METHODS.COD,
    paymentStatus: order.paymentStatus || 'PENDING',
    razorpayOrderId: null,
    amount: order.pricing?.totalPaise ?? rupeesToPaise(order.total || 0),
    currency: 'INR',
    status: order.status,
    pricing: order.pricing,
    requiresRazorpay: false,
  }
}

export async function getOrderForConfirmation(orderNumber, { trackingToken } = {}) {
  const order = await Order.findOne({ orderNumber: String(orderNumber || '').trim() })
  // Same response for unknown order and wrong/missing token — no existence oracle
  if (!tokenMatchesOrder(order, trackingToken)) {
    throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  }
  return toCustomerOrder(order)
}

export function toCustomerOrder(order) {
  const o = order.toJSON ? order.toJSON() : order
  const paymentMethod = o.paymentMethod || PAYMENT_METHODS.PREPAID
  const paymentStatus = o.paymentStatus || o.payment?.status || null
  return {
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    status: o.status,
    paymentMethod,
    paymentStatus,
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
    subtotal: o.subtotal,
    shipping: o.shipping,
    discount: o.discount,
    codFee: o.codFee,
    convenienceFee: o.convenienceFee,
    total: o.total,
    currency: o.currency || 'INR',
    payment: {
      status: o.payment?.status,
      method: o.payment?.method || paymentMethod,
      provider: o.payment?.provider,
      amountPaise: o.payment?.amountPaise,
      capturedAt: o.payment?.capturedAt,
      receivedAt: o.payment?.receivedAt,
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
      createdAt: h.createdAt,
    })),
  }
}
