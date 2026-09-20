import mongoose from 'mongoose'
import { AnalyticsEvent } from '../models/AnalyticsEvent.js'
import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { ApiError } from '../utils/ApiError.js'

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

export async function getOverview() {
  const [
    productCount,
    activeCount,
    views,
    addToCarts,
    checkoutStarted,
    orders,
    recentOrders,
    lowStock,
  ] = await Promise.all([
    Product.countDocuments(),
    Product.countDocuments({ active: true }),
    AnalyticsEvent.countDocuments({ type: 'product_view' }),
    AnalyticsEvent.countDocuments({ type: 'add_to_cart' }),
    AnalyticsEvent.countDocuments({ type: 'checkout_started' }),
    Order.find().lean(),
    Order.find().sort({ createdAt: -1 }).limit(8),
    Product.find({ active: true, stock: { $lte: 8 } }).sort({ stock: 1 }).limit(12),
  ])

  let unitsSold = 0
  let revenue = 0
  const paidOrders = orders.filter((o) => {
    if (o.status === 'cancelled' || o.status === 'CANCELLED') return false
    if (o.status === 'PAYMENT_FAILED' || o.status === 'PENDING_PAYMENT' || o.status === 'PAYMENT_EXPIRED') {
      return false
    }
    const pay = o.payment?.status || o.paymentStatus
    return pay === 'CAPTURED' || pay === 'paid' || o.status === 'CONFIRMED' || o.status === 'confirmed' || o.status === 'DELIVERED' || o.status === 'SHIPPED' || o.status === 'PROCESSING' || o.status === 'PACKED' || o.status === 'OUT_FOR_DELIVERY'
  })

  for (const o of paidOrders) {
    if (o.pricing?.totalPaise != null) {
      revenue += o.pricing.totalPaise / 100
    }
    for (const item of o.items || []) {
      unitsSold += item.quantity || 0
      if (o.pricing?.totalPaise == null && item.lineTotal != null) revenue += item.lineTotal
    }
  }

  const conversion =
    views > 0
      ? Number(((paidOrders.length / views) * 100).toFixed(2))
      : 0

  return {
    products: productCount,
    activeProducts: activeCount,
    views,
    addToCarts,
    checkoutStarted,
    orders: paidOrders.length,
    unitsSold,
    revenue,
    conversionRate: conversion,
    lowStock: lowStock.map((p) => p.toJSON()),
    recentOrders: recentOrders.map((o) => o.toJSON()),
  }
}

export async function getProductAnalytics() {
  const products = await Product.find().sort({ name: 1 })
  const [viewAgg, cartAgg, orders] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: { type: 'product_view', productId: { $ne: null } } },
      { $group: { _id: '$productId', views: { $sum: 1 } } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { type: 'add_to_cart', productId: { $ne: null } } },
      { $group: { _id: '$productId', addToCarts: { $sum: 1 } } },
    ]),
    Order.find({ status: { $ne: 'cancelled' } }).lean(),
  ])

  const viewsMap = Object.fromEntries(viewAgg.map((r) => [r._id.toString(), r.views]))
  const cartMap = Object.fromEntries(cartAgg.map((r) => [r._id.toString(), r.addToCarts]))

  const salesMap = {}
  const revenueMap = {}
  const categorySales = {}

  for (const o of orders) {
    for (const item of o.items || []) {
      const id = item.productId?.toString()
      if (!id) continue
      salesMap[id] = (salesMap[id] || 0) + item.quantity
      if (item.lineTotal != null) {
        revenueMap[id] = (revenueMap[id] || 0) + item.lineTotal
      }
    }
  }

  const rows = products.map((p) => {
    const id = p._id.toString()
    const purchases = salesMap[id] || 0
    if (purchases) {
      categorySales[p.category || 'Other'] =
        (categorySales[p.category || 'Other'] || 0) + purchases
    }
    return {
      id,
      name: p.name,
      slug: p.slug,
      category: p.category,
      stock: p.stock,
      active: p.active,
      views: viewsMap[id] || 0,
      addToCarts: cartMap[id] || 0,
      purchases,
      revenue: revenueMap[id] || 0,
    }
  })

  return {
    products: rows,
    byCategory: Object.entries(categorySales).map(([category, units]) => ({
      category,
      units,
    })),
  }
}
