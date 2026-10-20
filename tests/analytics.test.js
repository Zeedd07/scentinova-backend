/**
 * Admin analytics: revenue counts only collected money; refunds, COD cash and unpaid orders are separated.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { Payment } from '../src/models/Payment.js'
import { AnalyticsEvent } from '../src/models/AnalyticsEvent.js'
import { getAnalyticsReport } from '../src/services/analyticsService.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import { createAdmin, createProduct } from './helpers/fixtures.js'

const DAY = 24 * 60 * 60 * 1000

let app
let token
let seaweed
let lunar

/** Order with one line; `itemPaise` is the line total after any sale discount. */
async function makeOrder({
  product = seaweed,
  quantity = 1,
  itemPaise = 100000,
  discountPaise = 0,
  shippingPaise = 0,
  codFeePaise = 0,
  method = 'PREPAID',
  status = 'CONFIRMED',
  pay = 'CAPTURED',
  createdAt = new Date(),
  paidAt = createdAt,
} = {}) {
  const subtotalPaise = itemPaise + discountPaise
  const totalPaise = itemPaise + shippingPaise + codFeePaise
  const collected = pay === 'CAPTURED' || pay === 'PAID'
  const order = await Order.create({
    orderNumber: `SCN-TEST-${crypto.randomUUID().slice(0, 8)}`,
    customerSnapshot: { name: 'Test Buyer', email: 'buyer@example.com' },
    items: [
      {
        productId: product._id,
        name: product.name,
        quantity,
        unitPricePaise: subtotalPaise / quantity,
        subtotalPaise,
        discountPaise,
        totalPaise: itemPaise,
      },
    ],
    paymentMethod: method,
    pricing: { subtotalPaise, discountPaise, shippingPaise, codFeePaise, totalPaise },
    payment: {
      provider: method === 'COD' ? 'cod' : 'razorpay',
      status: pay,
      capturedAt: collected ? paidAt : null,
    },
    status,
  })
  await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt } })
  return order
}

function report(range = 'all') {
  return request(app)
    .get(`/api/admin/analytics/report?range=${range}`)
    .set('Authorization', `Bearer ${token}`)
}

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
  seaweed = await createProduct({ name: 'Seaweed', pricePaise: 100000 })
  lunar = await createProduct({ name: 'Lunar Leather', pricePaise: 89900 })
})

describe('admin analytics access', () => {
  it('needs an admin login', async () => {
    const res = await request(app).get('/api/admin/analytics/report')
    assert.equal(res.status, 401)
  })

  it('rejects an unknown range', async () => {
    const res = await report('1y')
    assert.equal(res.status, 400)
  })
})

describe('revenue counts only collected money', () => {
  it('separates paid, COD awaiting cash, refunds and unpaid orders', async () => {
    await makeOrder({ itemPaise: 100000, shippingPaise: 9900 })
    await makeOrder({ method: 'COD', pay: 'PAID', status: 'DELIVERED', itemPaise: 89900, product: lunar, codFeePaise: 8500 })
    await makeOrder({ method: 'COD', pay: 'PENDING', status: 'SHIPPED', itemPaise: 100000 })
    await makeOrder({ status: 'CANCELLED', pay: 'CREATED' })
    await makeOrder({ status: 'PAYMENT_EXPIRED', pay: 'FAILED' })
    await makeOrder({ status: 'PENDING_PAYMENT', pay: 'CREATED' })
    await makeOrder({ method: 'COD', pay: 'FAILED', status: 'CANCELLED' })
    const refunded = await makeOrder({ status: 'REFUND_PENDING', itemPaise: 50000, quantity: 2 })
    await Payment.create({
      orderId: refunded._id,
      orderNumber: refunded.orderNumber,
      amountPaise: 50000,
      status: 'REFUNDED',
      refundedPaise: 50000,
    })

    const res = await report('all')
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const { money, products } = res.body.data

    assert.equal(money.receivedPaise, 109900 + 98400 + 50000)
    assert.equal(money.refundedPaise, 50000)
    assert.equal(money.netPaise, 109900 + 98400)
    assert.equal(money.paidOrders, 3)
    assert.deepEqual(money.online, { orders: 2, paise: 109900 + 50000 })
    assert.deepEqual(money.cod, { orders: 1, paise: 98400 })
    assert.deepEqual(money.codAwaiting, { orders: 1, paise: 100000 })
    assert.deepEqual(money.unpaid, { orders: 4, cancelled: 2, failedOrExpired: 1, awaitingPayment: 1 })

    const sea = products.find((p) => p.name === 'Seaweed')
    const lun = products.find((p) => p.name === 'Lunar Leather')
    assert.deepEqual([sea.unitsSold, sea.revenuePaise], [1, 100000], 'refunded and unpaid lines are not sales')
    assert.deepEqual([lun.unitsSold, lun.revenuePaise], [1, 89900])
  })

  it('treats a refund-pending order with no refund record as fully refunded', async () => {
    await makeOrder({ status: 'REFUND_PENDING', itemPaise: 40000 })
    const { money } = (await report('all')).body.data
    assert.equal(money.receivedPaise, 40000)
    assert.equal(money.refundedPaise, 40000)
    assert.equal(money.netPaise, 0)
  })

  it('counts partial refunds from the payment record and keeps the sale', async () => {
    const order = await makeOrder({ itemPaise: 100000, status: 'DELIVERED' })
    await Payment.create({
      orderId: order._id,
      orderNumber: order.orderNumber,
      amountPaise: 100000,
      status: 'PARTIALLY_REFUNDED',
      refundedPaise: 30000,
    })
    const { money, products } = (await report('all')).body.data
    assert.equal(money.netPaise, 70000)
    assert.equal(products.find((p) => p.name === 'Seaweed').unitsSold, 1)
  })

  it('breaks received money into items, sale discounts and fees that add up', async () => {
    await makeOrder({ itemPaise: 80000, discountPaise: 20000, shippingPaise: 9900 })
    await makeOrder({ method: 'COD', pay: 'PAID', status: 'DELIVERED', itemPaise: 89900, codFeePaise: 8500 })
    const { money } = (await report('all')).body.data
    const b = money.breakdown
    assert.equal(b.itemsPaise, 100000 + 89900)
    assert.equal(b.discountPaise, 20000)
    assert.equal(
      b.itemsPaise - b.discountPaise + b.shippingPaise + b.codFeePaise + b.convenienceFeePaise + b.taxPaise,
      money.receivedPaise,
    )
    assert.equal(money.averageOrderPaise, Math.round(money.receivedPaise / 2))
  })

  it('reads legacy orders that only stored rupee totals', async () => {
    const order = await makeOrder({ pay: 'CREATED', status: 'PROCESSING' })
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { paymentStatus: 'paid', 'pricing.totalPaise': 0, total: 1098 } },
    )
    const { money } = (await report('all')).body.data
    assert.equal(money.paidOrders, 1)
    assert.equal(money.receivedPaise, 109800)
  })
})

describe('date ranges', () => {
  const now = new Date('2026-10-11T12:00:00Z')

  it('uses the day money was collected, in India time', async () => {
    await makeOrder({ itemPaise: 50000, createdAt: new Date(now - 40 * DAY) })
    // 00:30 on 11 Oct in India
    await makeOrder({ itemPaise: 70000, createdAt: new Date('2026-10-10T18:00:00Z'), paidAt: new Date('2026-10-10T19:00:00Z') })

    const month = await getAnalyticsReport({ range: '30d', now })
    assert.equal(month.money.receivedPaise, 70000)
    assert.equal(month.timeline.unit, 'day')
    assert.equal(month.timeline.points.length, 30)
    assert.equal(month.timeline.points.at(-1).key, '2026-10-11')
    assert.equal(month.timeline.points.at(-1).netPaise, 70000)
    assert.equal(month.timeline.points[0].key, '2026-09-12')

    const quarter = await getAnalyticsReport({ range: '90d', now })
    assert.equal(quarter.money.receivedPaise, 120000)

    const week = await getAnalyticsReport({ range: '7d', now })
    assert.equal(week.timeline.points.length, 7)
  })

  it('keeps a custom India-time range inclusive and rejects bad dates', async () => {
    await makeOrder({ itemPaise: 40000, createdAt: new Date('2026-10-05T06:00:00Z') })
    await makeOrder({ itemPaise: 90000, createdAt: new Date('2026-09-01T06:00:00Z') })

    const custom = await getAnalyticsReport({
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-11',
      now,
    })
    assert.equal(custom.range.key, 'custom')
    assert.equal(custom.money.receivedPaise, 40000)
    assert.equal(custom.timeline.points[0].key, '2026-10-01')
    assert.equal(custom.timeline.points.at(-1).key, '2026-10-11')

    const bad = await request(app)
      .get('/api/admin/analytics/report?range=custom&from=2026-10-11&to=2026-10-01')
      .set('Authorization', `Bearer ${token}`)
    assert.equal(bad.status, 400)

    const future = await request(app)
      .get('/api/admin/analytics/report?range=custom&from=2026-10-01&to=2099-01-01')
      .set('Authorization', `Bearer ${token}`)
    assert.equal(future.status, 400)
  })

  it('charts long all-time spans by month', async () => {
    await makeOrder({ itemPaise: 50000, createdAt: new Date(now - 200 * DAY) })
    await makeOrder({ itemPaise: 30000, createdAt: new Date(now - DAY) })
    const all = await getAnalyticsReport({ range: 'all', now })
    assert.equal(all.timeline.unit, 'month')
    assert.equal(all.timeline.points.at(-1).key, '2026-10')
    assert.equal(all.timeline.points.reduce((s, p) => s + p.netPaise, 0), 80000)
  })

  it('counts storefront events inside the range only', async () => {
    await AnalyticsEvent.create([
      { type: 'product_view', productId: seaweed._id },
      { type: 'product_view', productId: seaweed._id },
      { type: 'add_to_cart', productId: seaweed._id },
      { type: 'checkout_started' },
    ])
    const old = await AnalyticsEvent.create({ type: 'product_view', productId: lunar._id })
    await AnalyticsEvent.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 60 * DAY) } })

    const month = (await report('30d')).body.data
    assert.deepEqual(month.funnel, { views: 2, addToCarts: 1, checkoutStarted: 1, paidOrders: 0 })
    assert.equal(month.products.find((p) => p.name === 'Seaweed').views, 2)
    const all = (await report('all')).body.data
    assert.equal(all.funnel.views, 3)
  })
})

describe('orders placed', () => {
  const now = new Date('2026-10-11T12:00:00Z')

  it('counts every order placed in the range by status and payment method, apart from revenue', async () => {
    await makeOrder({ createdAt: new Date('2026-10-11T05:00:00Z') })
    await makeOrder({ method: 'COD', pay: 'PENDING', status: 'SHIPPED', createdAt: new Date('2026-10-10T05:00:00Z') })
    await makeOrder({ status: 'CANCELLED', pay: 'CREATED', createdAt: new Date('2026-10-10T06:00:00Z') })
    await makeOrder({ status: 'PAYMENT_EXPIRED', pay: 'FAILED', createdAt: new Date(now - 40 * DAY) })

    const week = await getAnalyticsReport({ range: '7d', now })
    assert.equal(week.placed.orders, 3)
    assert.deepEqual(week.placed.byStatus, { CONFIRMED: 1, SHIPPED: 1, CANCELLED: 1 })
    assert.deepEqual(week.placed.byMethod, { PREPAID: 2, COD: 1 })
    assert.equal(week.money.paidOrders, 1, 'placed orders are not revenue')

    const byDay = Object.fromEntries(week.timeline.points.map((p) => [p.key, p.placedOrders]))
    assert.equal(byDay['2026-10-11'], 1)
    assert.equal(byDay['2026-10-10'], 2)
    assert.equal(week.timeline.points.reduce((s, p) => s + p.placedOrders, 0), week.placed.orders)
  })

  it('returns zeros, not NaN, when nothing happened', async () => {
    const week = await getAnalyticsReport({ range: '7d', now })
    assert.deepEqual(week.placed, { orders: 0, byStatus: {}, byMethod: { PREPAID: 0, COD: 0 } })
    assert.equal(week.money.averageOrderPaise, 0)
    assert.ok(week.timeline.points.every((p) => p.netPaise === 0 && p.placedOrders === 0))
  })
})

describe('admin dashboard', () => {
  it('counts every low-stock product, not just the listed ones', async () => {
    for (let i = 0; i < 14; i += 1) {
      await createProduct({ name: `Low ${String(i).padStart(2, '0')}`, stock: i % 3 })
    }
    await createProduct({ name: 'Plenty', stock: 9 })
    const res = await request(app).get('/api/admin/dashboard').set('Authorization', `Bearer ${token}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.lowStockCount, 14)
    assert.equal(res.body.data.lowStock.length, 12)
    assert.equal(res.body.data.lowStockThreshold, 8)
  })

  it('shows net collected revenue, not unpaid or uncollected orders', async () => {
    await makeOrder({ itemPaise: 100000 })
    await makeOrder({ method: 'COD', pay: 'PENDING', status: 'CONFIRMED', itemPaise: 500000 })
    await makeOrder({ status: 'CANCELLED', pay: 'CREATED', itemPaise: 900000 })
    const res = await request(app).get('/api/admin/dashboard').set('Authorization', `Bearer ${token}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.revenue, 1000)
    assert.equal(res.body.data.orders, 1)
    assert.equal(res.body.data.unitsSold, 1)
    assert.equal(res.body.data.codAwaitingRevenue, 5000)
  })
})
