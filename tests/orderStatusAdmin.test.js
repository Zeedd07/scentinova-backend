/**
 * Admin order status updates flow through to public tracking: allowed transitions,
 * shipment requirements, customer messages vs internal notes, message-only updates.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { createPaymentOrder } from '../src/services/checkoutService.js'
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
  product = await createProduct({ name: 'Seaweed', pricePaise: 49900, fees: standardFees() })
  stubRazorpay()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

async function codOrder() {
  const created = await createPaymentOrder(
    checkoutInput({ productId: product._id, paymentMethod: 'COD' }),
  )
  const order = await Order.findOne({ orderNumber: created.orderNumber })
  return { id: String(order._id), orderNumber: created.orderNumber, trackingToken: created.trackingToken }
}

function setStatus(id, body) {
  return request(app).patch(`/api/admin/orders/${id}/status`).set(auth()).send(body)
}

function track(o) {
  return request(app)
    .post('/api/orders/track')
    .send({ orderNumber: o.orderNumber, token: o.trackingToken })
}

describe('admin order status', () => {
  it('exposes the allowed next statuses on list and detail', async () => {
    const o = await codOrder()
    const detail = await request(app).get(`/api/admin/orders/${o.id}`).set(auth())
    assert.equal(detail.status, 200)
    assert.deepEqual(detail.body.data.order.allowedNextStatuses, ['PROCESSING', 'CANCELLED'])

    const list = await request(app).get('/api/admin/orders').set(auth())
    assert.deepEqual(list.body.data.orders[0].allowedNextStatuses, ['PROCESSING', 'CANCELLED'])
  })

  it('walks an order to delivered and the customer sees each step', async () => {
    const o = await codOrder()

    let res = await setStatus(o.id, { status: 'PROCESSING' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.order.allowedNextStatuses, ['PACKED', 'CANCELLED'])

    res = await setStatus(o.id, { status: 'PACKED' })
    assert.equal(res.status, 200)

    res = await setStatus(o.id, { status: 'SHIPPED' })
    assert.equal(res.status, 400, 'shipping needs carrier + tracking number')

    res = await setStatus(o.id, {
      status: 'SHIPPED',
      shipping: { carrier: 'Delhivery', trackingNumber: 'DL123', trackingUrl: 'https://track.example.com/DL123' },
      customerMessage: 'Your parcel is on its way.',
      note: 'Packed by Asha, box B2',
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.order.allowedNextStatuses, ['OUT_FOR_DELIVERY', 'DELIVERED'])

    const shipped = (await track(o)).body.data.order
    assert.equal(shipped.status, 'SHIPPED')
    assert.equal(shipped.statusLabel, 'Shipped')
    assert.equal(shipped.shipment.trackingNumber, 'DL123')
    assert.equal(shipped.updates[0].status, 'SHIPPED')
    assert.equal(shipped.updates[0].message, 'Your parcel is on its way.')
    assert.deepEqual(
      shipped.updates.map((u) => u.status),
      ['SHIPPED', 'PACKED', 'PROCESSING', 'CONFIRMED'],
    )
    assert.ok(!JSON.stringify(shipped).includes('Asha'), 'internal notes stay internal')
    assert.ok(!JSON.stringify(shipped).includes('admin@test.local'))

    await setStatus(o.id, { status: 'OUT_FOR_DELIVERY' })
    res = await setStatus(o.id, { status: 'DELIVERED' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.order.allowedNextStatuses, [])

    const delivered = (await track(o)).body.data.order
    assert.equal(delivered.isDelivered, true)
    assert.ok(delivered.timeline.every((s) => s.state === 'complete'))
  })

  it('rejects skipped steps and re-applying the current status', async () => {
    const o = await codOrder()
    const jump = await setStatus(o.id, { status: 'DELIVERED' })
    assert.equal(jump.status, 400)
    assert.equal(jump.body.error.code, 'INVALID_ORDER_STATUS')

    await setStatus(o.id, { status: 'PROCESSING' })
    const again = await setStatus(o.id, { status: 'PROCESSING' })
    assert.equal(again.status, 400)
    assert.equal(again.body.error.code, 'INVALID_ORDER_STATUS')

    const stored = await Order.findById(o.id)
    assert.equal(stored.statusHistory.filter((h) => h.status === 'PROCESSING').length, 1)
  })

  it('cannot cancel once shipped', async () => {
    const o = await codOrder()
    await setStatus(o.id, { status: 'PROCESSING' })
    await setStatus(o.id, { status: 'PACKED' })
    await setStatus(o.id, { status: 'SHIPPED', shipping: { carrier: 'X', trackingNumber: '1' } })
    const res = await setStatus(o.id, { status: 'CANCELLED' })
    assert.equal(res.status, 400)
  })

  it('limits message length', async () => {
    const o = await codOrder()
    const res = await setStatus(o.id, { status: 'PROCESSING', customerMessage: 'x'.repeat(281) })
    assert.equal(res.status, 400)
  })

  it('requires admin auth', async () => {
    const o = await codOrder()
    const res = await request(app)
      .patch(`/api/admin/orders/${o.id}/status`)
      .send({ status: 'PROCESSING' })
    assert.equal(res.status, 401)
    const upd = await request(app)
      .post(`/api/admin/orders/${o.id}/updates`)
      .send({ customerMessage: 'hi' })
    assert.equal(upd.status, 401)
  })
})

describe('admin order updates (no status change)', () => {
  it('posts a customer message that shows on tracking without changing status', async () => {
    const o = await codOrder()
    const res = await request(app)
      .post(`/api/admin/orders/${o.id}/updates`)
      .set(auth())
      .send({ customerMessage: '  Delayed by a day due to weather.  ' })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.order.status, 'CONFIRMED')

    const tracked = (await track(o)).body.data.order
    assert.equal(tracked.status, 'CONFIRMED')
    assert.equal(tracked.updates[0].status, 'CONFIRMED')
    assert.equal(tracked.updates[0].message, 'Delayed by a day due to weather.')
  })

  it('keeps note-only updates off the customer feed', async () => {
    const o = await codOrder()
    const before = (await track(o)).body.data.order.updates.length
    const res = await request(app)
      .post(`/api/admin/orders/${o.id}/updates`)
      .set(auth())
      .send({ note: 'Customer called about gift wrap' })
    assert.equal(res.status, 200)
    const tracked = (await track(o)).body.data.order
    assert.equal(tracked.updates.length, before)
    assert.ok(!JSON.stringify(tracked).includes('gift wrap'))
  })

  it('rejects an empty update', async () => {
    const o = await codOrder()
    const res = await request(app)
      .post(`/api/admin/orders/${o.id}/updates`)
      .set(auth())
      .send({ customerMessage: '   ' })
    assert.equal(res.status, 400)
  })
})
