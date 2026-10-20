/**
 * Admin order safety: cancelled stock comes back once, refunds never exceed what is left,
 * refund states only come from the refund flow, and list filters take plain text only.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { Payment } from '../src/models/Payment.js'
import { Product } from '../src/models/Product.js'
import { createPaymentOrder } from '../src/services/checkoutService.js'
import { restockCommittedReservations } from '../src/services/inventoryService.js'
import { getRazorpay } from '../src/config/razorpay.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import {
  checkoutInput,
  createAdmin,
  createProduct,
  standardFees,
  stubRazorpay,
} from './helpers/fixtures.js'

let app
let token
let product

before(async () => {
  await startTestDb()
  app = createApp()
})

after(async () => {
  await stopTestDb()
})

beforeEach(async () => {
  await clearTestDb()
  ;({ token } = await createAdmin())
  product = await createProduct({ name: 'Seaweed', pricePaise: 49900, stock: 10, fees: standardFees() })
  stubRazorpay()
})

const auth = () => ({ Authorization: `Bearer ${token}` })
const stock = async () => (await Product.findById(product._id)).stock

async function codOrder(quantity = 2) {
  const created = await createPaymentOrder(
    checkoutInput({ productId: product._id, paymentMethod: 'COD', quantity }),
  )
  const order = await Order.findOne({ orderNumber: created.orderNumber })
  return String(order._id)
}

/** Captured prepaid order, as if Razorpay had confirmed the payment. */
async function capturedOrder(totalPaise = 100000) {
  const order = await Order.create({
    orderNumber: `SCN-TEST-${crypto.randomUUID().slice(0, 8)}`,
    customerSnapshot: { name: 'Test Buyer', email: 'buyer@example.com' },
    items: [{ productId: product._id, name: product.name, quantity: 1, unitPricePaise: totalPaise, subtotalPaise: totalPaise, totalPaise }],
    paymentMethod: 'PREPAID',
    pricing: { subtotalPaise: totalPaise, totalPaise },
    payment: { provider: 'razorpay', status: 'CAPTURED', razorpayPaymentId: 'pay_test_1', capturedAt: new Date() },
    status: 'DELIVERED',
  })
  await Payment.create({ orderId: order._id, orderNumber: order.orderNumber, amountPaise: totalPaise, status: 'CAPTURED' })
  return String(order._id)
}

function refund(id, body = {}) {
  return request(app).post(`/api/admin/orders/${id}/refund`).set(auth()).send(body)
}

describe('cancelling restocks committed inventory', () => {
  it('returns stock once when a confirmed COD order is cancelled', async () => {
    const id = await codOrder(2)
    assert.equal(await stock(), 8, 'COD checkout commits stock')

    const res = await request(app).patch(`/api/admin/orders/${id}/status`).set(auth()).send({ status: 'CANCELLED' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(await stock(), 10)

    const again = await restockCommittedReservations(id)
    assert.equal(again.restocked, 0, 'a retry never restocks twice')
    assert.equal(await stock(), 10)
  })

  it('returns stock when an uncollected COD order is closed through refund', async () => {
    const id = await codOrder(3)
    assert.equal(await stock(), 7)
    const res = await refund(id, { reason: 'Customer cancelled' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.order.status, 'CANCELLED')
    assert.equal(await stock(), 10)
  })

  it('does not restock once the order has shipped', async () => {
    const id = await codOrder(1)
    await request(app)
      .patch(`/api/admin/orders/${id}/status`)
      .set(auth())
      .send({ status: 'SHIPPED', shipping: { carrier: 'Delhivery', trackingNumber: 'DL1' } })
    const res = await refund(id, { reason: 'Refused at door' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(await stock(), 9, 'goods in transit are not back on the shelf')
  })
})

describe('refund limits', () => {
  it('never refunds more than what is left on the payment', async () => {
    const rzp = getRazorpay()
    const calls = []
    rzp.payments.refund = async (paymentId, params) => {
      calls.push(params.amount)
      return { id: `rfnd_${calls.length}`, status: 'pending' }
    }
    const id = await capturedOrder(100000)

    const first = await refund(id, { amountPaise: 60000 })
    assert.equal(first.status, 200, JSON.stringify(first.body))

    const tooMuch = await refund(id, { amountPaise: 60000 })
    assert.equal(tooMuch.status, 400)
    assert.deepEqual(calls, [60000], 'Razorpay is not asked for the excess')

    const rest = await refund(id)
    assert.equal(rest.status, 200, JSON.stringify(rest.body))
    assert.deepEqual(calls, [60000, 40000], 'a refund without an amount takes only the remainder')
    const payment = await Payment.findOne({ orderId: id })
    assert.equal(payment.refundedPaise, 100000)
    assert.equal(payment.status, 'REFUNDED')

    const done = await refund(id)
    assert.equal(done.status, 400)
  })
})

describe('admin status input', () => {
  it('cannot jump to refund pending without a refund', async () => {
    const id = await codOrder(1)
    const res = await request(app).patch(`/api/admin/orders/${id}/status`).set(auth()).send({ status: 'REFUND_PENDING' })
    assert.equal(res.status, 400)
    assert.equal((await Order.findById(id)).status, 'CONFIRMED')
  })

  it('accepts only plain text in the order filters', async () => {
    await codOrder(1)
    const status = await request(app).get('/api/admin/orders?status=CONFIRMED&status=CANCELLED').set(auth())
    assert.equal(status.status, 400)
    const q = await request(app).get('/api/admin/orders?q=a&q=b').set(auth())
    assert.equal(q.status, 400)
    const ok = await request(app).get('/api/admin/orders?status=CONFIRMED').set(auth())
    assert.equal(ok.body.data.orders.length, 1)
  })

  it('filters by cash on delivery, prepaid, and product', async () => {
    const other = await createProduct({ name: 'Lunar Leather', pricePaise: 89900, stock: 4, fees: standardFees() })
    await codOrder(1)
    await capturedOrder()
    await Order.create({
      orderNumber: `SCN-TEST-${crypto.randomUUID().slice(0, 8)}`,
      customerSnapshot: { name: 'Other Buyer', email: 'other@example.com' },
      items: [{ productId: other._id, name: other.name, quantity: 1, unitPricePaise: 89900, subtotalPaise: 89900, totalPaise: 89900 }],
      paymentMethod: 'PREPAID',
      pricing: { subtotalPaise: 89900, totalPaise: 89900 },
      payment: { provider: 'razorpay', status: 'CAPTURED' },
      status: 'CONFIRMED',
    })

    const cod = await request(app).get('/api/admin/orders?method=COD').set(auth())
    assert.equal(cod.status, 200)
    assert.equal(cod.body.data.orders.length, 1)
    assert.equal(cod.body.data.orders[0].paymentMethod, 'COD')

    const prepaid = await request(app).get('/api/admin/orders?method=PREPAID').set(auth())
    assert.equal(prepaid.status, 200)
    assert.equal(prepaid.body.data.orders.length, 2)
    assert.ok(prepaid.body.data.orders.every((order) => order.paymentMethod === 'PREPAID'))

    const byProduct = await request(app).get(`/api/admin/orders?product=${other._id}`).set(auth())
    assert.equal(byProduct.status, 200)
    assert.equal(byProduct.body.data.orders.length, 1)
    assert.equal(byProduct.body.data.orders[0].items[0].name, 'Lunar Leather')

    const badMethod = await request(app).get('/api/admin/orders?method=UPI').set(auth())
    assert.equal(badMethod.status, 400)
    const badProduct = await request(app).get('/api/admin/orders?product=not-an-id').set(auth())
    assert.equal(badProduct.status, 400)
  })

  it('sorts by amount and matches more than one product', async () => {
    const other = await createProduct({ name: 'Lunar Leather', pricePaise: 89900, stock: 4, fees: standardFees() })
    await capturedOrder(40000)
    await Order.create({
      orderNumber: `SCN-TEST-${crypto.randomUUID().slice(0, 8)}`,
      customerSnapshot: { name: 'Other Buyer', email: 'other@example.com' },
      items: [{ productId: other._id, name: other.name, quantity: 1, unitPricePaise: 200000, subtotalPaise: 200000, totalPaise: 200000 }],
      paymentMethod: 'PREPAID',
      pricing: { subtotalPaise: 200000, totalPaise: 200000 },
      payment: { provider: 'razorpay', status: 'CAPTURED' },
      status: 'CONFIRMED',
    })

    const res = await request(app)
      .get(`/api/admin/orders?product=${product._id},${other._id}&sort=amount-high,oldest`)
      .set(auth())
    assert.equal(res.status, 200)
    assert.equal(res.body.data.orders.length, 2)
    assert.ok(res.body.data.orders[0].pricing.totalPaise > res.body.data.orders[1].pricing.totalPaise)

    const bad = await request(app).get('/api/admin/orders?sort=name').set(auth())
    assert.equal(bad.status, 400)
  })

  it('answers a malformed order id with 400, not a server error', async () => {
    const res = await request(app).get('/api/admin/orders/not-an-id').set(auth())
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'INVALID_ID')
  })
})

describe('public catalogue search', () => {
  it('treats search text literally', async () => {
    const bad = await request(app).get('/api/products?search=(')
    assert.equal(bad.status, 200)
    assert.equal(bad.body.data.products.length, 0)
    const hit = await request(app).get('/api/products?search=sea')
    assert.equal(hit.body.data.products.length, 1)
  })

  it('ignores a repeated category filter instead of matching arrays', async () => {
    const res = await request(app).get('/api/products?category=a&category=b')
    assert.equal(res.status, 200)
    assert.equal(res.body.data.products.length, 1)
  })
})
