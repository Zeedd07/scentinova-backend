import { Product } from '../models/Product.js'
import { InventoryReservation } from '../models/InventoryReservation.js'
import { ApiError } from '../utils/ApiError.js'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

async function sumActiveReservations(productId) {
  const reserved = await InventoryReservation.aggregate([
    {
      $match: {
        productId,
        status: 'ACTIVE',
        expiresAt: { $gt: new Date() },
      },
    },
    { $group: { _id: null, qty: { $sum: '$quantity' } } },
  ])
  return reserved[0]?.qty || 0
}

export async function getAvailableStock(productId, { excludeOrderId } = {}) {
  const product = await Product.findById(productId).select(
    'stock trackInventory allowBackorder',
  )
  if (!product) return 0
  if (product.trackInventory === false || product.allowBackorder) {
    return Number.MAX_SAFE_INTEGER
  }

  const match = {
    productId,
    status: 'ACTIVE',
    expiresAt: { $gt: new Date() },
  }
  if (excludeOrderId) match.orderId = { $ne: excludeOrderId }

  const reserved = await InventoryReservation.aggregate([
    { $match: match },
    { $group: { _id: null, qty: { $sum: '$quantity' } } },
  ])
  const reservedQty = reserved[0]?.qty || 0
  return Math.max(0, product.stock - reservedQty)
}

export async function reserveForOrder(orderId, lines, { ttlMinutes } = {}) {
  const minutes = ttlMinutes ?? env.orderPaymentTtlMinutes
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000)

  try {
    for (const line of lines) {
      const product = await Product.findById(line.productId)
      if (!product || !product.active) {
        throw new ApiError(400, 'PRODUCT_UNAVAILABLE', 'A product is no longer available.')
      }

      if (product.trackInventory !== false && !product.allowBackorder) {
        const available = await getAvailableStock(product._id, { excludeOrderId: orderId })
        if (available < line.quantity) {
          throw new ApiError(
            400,
            'INSUFFICIENT_STOCK',
            `${product.name} does not have enough stock.`,
          )
        }
      }

      await InventoryReservation.create({
        orderId,
        productId: product._id,
        quantity: line.quantity,
        expiresAt,
        status: 'ACTIVE',
      })

      if (product.trackInventory !== false && !product.allowBackorder) {
        const totalReserved = await sumActiveReservations(product._id)
        if (totalReserved > product.stock) {
          throw new ApiError(
            409,
            'INSUFFICIENT_STOCK',
            `${product.name} was just reserved by another customer.`,
          )
        }
      }
    }
  } catch (err) {
    await releaseReservations(orderId, 'RELEASED')
    throw err
  }

  return { expiresAt }
}

export async function releaseReservations(orderId, status = 'RELEASED') {
  await InventoryReservation.updateMany(
    { orderId, status: 'ACTIVE' },
    { $set: { status } },
  )
}

export async function commitReservations(orderId) {
  const active = await InventoryReservation.find({ orderId, status: 'ACTIVE' })
  if (!active.length) {
    const committed = await InventoryReservation.exists({
      orderId,
      status: 'COMMITTED',
    })
    return { committed: Boolean(committed) }
  }

  for (const reservation of active) {
    const product = await Product.findById(reservation.productId)
    if (!product) {
      throw new ApiError(409, 'PRODUCT_UNAVAILABLE', 'Product missing during inventory commit.')
    }

    if (product.trackInventory !== false && !product.allowBackorder) {
      const updated = await Product.findOneAndUpdate(
        { _id: product._id, stock: { $gte: reservation.quantity } },
        { $inc: { stock: -reservation.quantity } },
        { new: true },
      )
      if (!updated) {
        logger.error('commitReservations insufficient stock', {
          orderId: String(orderId),
          productId: String(reservation.productId),
        })
        throw new ApiError(
          409,
          'INSUFFICIENT_STOCK',
          'Could not commit inventory for this order.',
        )
      }
    }

    reservation.status = 'COMMITTED'
    await reservation.save()
  }

  return { committed: true }
}

export async function expireStaleReservations() {
  const now = new Date()
  const result = await InventoryReservation.updateMany(
    { status: 'ACTIVE', expiresAt: { $lte: now } },
    { $set: { status: 'EXPIRED' } },
  )
  return { expired: result.modifiedCount || 0 }
}
