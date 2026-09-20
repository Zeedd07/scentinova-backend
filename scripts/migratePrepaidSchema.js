/**
 * Backfill pricePaise and normalize legacy order statuses.
 * Run: node scripts/migratePrepaidSchema.js
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { rupeesToPaise } from '../src/utils/money.js'
import { mapLegacyStatus } from '../src/utils/orderStatus.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

await mongoose.connect(process.env.MONGODB_URI)
const db = mongoose.connection.db

const products = await db.collection('products').find({}).toArray()
let pUpdated = 0
for (const product of products) {
  const pricePaise =
    product.pricePaise != null
      ? Math.round(Number(product.pricePaise))
      : rupeesToPaise(product.price ?? 999)
  const price = pricePaise / 100
  const sku = product.sku || String(product.slug || product._id).toUpperCase()
  await db.collection('products').updateOne(
    { _id: product._id },
    {
      $set: {
        pricePaise,
        price,
        sku,
        trackInventory: product.trackInventory !== false,
        allowBackorder: Boolean(product.allowBackorder),
        currency: product.currency || 'INR',
      },
    },
  )
  pUpdated += 1
}

const orders = await db.collection('orders').find({}).toArray()
let oUpdated = 0
for (const order of orders) {
  const status = mapLegacyStatus(order.status, order.paymentStatus || order.payment?.status)
  const subtotalPaise =
    order.pricing?.subtotalPaise ??
    (order.subtotal != null ? rupeesToPaise(order.subtotal) : 0)
  const shippingPaise =
    order.pricing?.shippingPaise ??
    (order.shipping != null ? rupeesToPaise(order.shipping) : 0)
  const totalPaise =
    order.pricing?.totalPaise ??
    (order.total != null ? rupeesToPaise(order.total) : subtotalPaise + shippingPaise)

  const items = (order.items || []).map((item) => {
    const unitPricePaise =
      item.unitPricePaise ??
      (item.unitPrice != null ? rupeesToPaise(item.unitPrice) : 0)
    const totalItemPaise =
      item.totalPaise ??
      (item.lineTotal != null ? rupeesToPaise(item.lineTotal) : unitPricePaise * item.quantity)
    return {
      ...item,
      unitPricePaise,
      subtotalPaise: item.subtotalPaise ?? totalItemPaise,
      discountPaise: item.discountPaise ?? 0,
      taxPaise: item.taxPaise ?? 0,
      totalPaise: totalItemPaise,
    }
  })

  await db.collection('orders').updateOne(
    { _id: order._id },
    {
      $set: {
        status,
        items,
        pricing: {
          currency: 'INR',
          subtotalPaise,
          discountPaise: 0,
          taxPaise: 0,
          shippingPaise,
          totalPaise,
        },
        customerSnapshot: order.customerSnapshot || {
          name: order.customer?.name || '',
          email: order.customer?.email || '',
          phone: order.customer?.phone || null,
          firstName: (order.customer?.name || '').split(' ')[0] || '',
          lastName: (order.customer?.name || '').split(' ').slice(1).join(' ') || '',
        },
        payment: order.payment || {
          provider: 'razorpay',
          status:
            order.paymentStatus === 'paid'
              ? 'CAPTURED'
              : order.paymentStatus === 'failed'
                ? 'FAILED'
                : order.paymentStatus === 'refunded'
                  ? 'REFUNDED'
                  : 'CREATED',
          amountPaise: totalPaise,
          currency: 'INR',
        },
      },
    },
  )
  oUpdated += 1
}

console.log(JSON.stringify({ productsUpdated: pUpdated, ordersUpdated: oUpdated }, null, 2))
await mongoose.disconnect()
