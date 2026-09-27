/**
 * Existing Razorpay protections still hold after the pricing refactor:
 * signature verification, amount verification, order-id match, webhook HMAC + idempotency.
 */
import { TEST_SECRETS } from './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import {
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../src/services/razorpayService.js'
import { createPaymentOrder } from '../src/services/checkoutService.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import {
  checkoutInput,
  createProduct,
  hmacHex,
  standardFees,
  stubRazorpay,
} from './helpers/fixtures.js'

let app
let product
let rzp

function paymentSignature(orderId, paymentId) {
  return hmacHex(TEST_SECRETS.razorpayKeySecret, `${orderId}|${paymentId}`)
}

async function prepaidOrder() {
  const res = await createPaymentOrder(
    checkoutInput({ productId: product._id, paymentMethod: 'PREPAID' }),
  )
  return res
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
  product = await createProduct({ name: 'Seaweed', pricePaise: 49900, fees: standardFees() })
  rzp = stubRazorpay()
})

describe('signature helpers', () => {
  it('accepts a valid payment signature and rejects a tampered one', () => {
    const sig = paymentSignature('order_abc', 'pay_xyz')
    assert.equal(
      verifyPaymentSignature({
        razorpayOrderId: 'order_abc',
        razorpayPaymentId: 'pay_xyz',
        razorpaySignature: sig,
      }),
      true,
    )
    assert.throws(
      () =>
        verifyPaymentSignature({
          razorpayOrderId: 'order_abc',
          razorpayPaymentId: 'pay_other',
          razorpaySignature: sig,
        }),
      (err) => err.code === 'PAYMENT_VERIFICATION_FAILED',
    )
  })

  it('accepts a valid webhook HMAC and rejects a tampered body', () => {
    const body = Buffer.from(JSON.stringify({ event: 'payment.captured' }))
    const sig = hmacHex(TEST_SECRETS.razorpayWebhookSecret, body)
    assert.equal(verifyWebhookSignature(body, sig), true)
    assert.throws(
      () => verifyWebhookSignature(Buffer.from('{"event":"payment.failed"}'), sig),
      (err) => err.code === 'INVALID_WEBHOOK',
    )
  })
})

describe('POST /api/payments/verify', () => {
  it('confirms a prepaid order when signature and paid amount match the stored total', async () => {
    const created = await prepaidOrder()
    rzp.setPaymentAmount(created.amount)
    const res = await request(app)
      .post('/api/payments/verify')
      .send({
        orderNumber: created.orderNumber,
        razorpayOrderId: created.razorpayOrderId,
        razorpayPaymentId: 'pay_test_ok',
        razorpaySignature: paymentSignature(created.razorpayOrderId, 'pay_test_ok'),
      })
    assert.equal(res.status, 200)
    const order = await Order.findOne({ orderNumber: created.orderNumber }).lean()
    assert.equal(order.status, 'CONFIRMED')
    assert.equal(order.paymentStatus, 'PAID')
    assert.equal(order.pricing.totalPaise, 60800)
  })

  it('rejects an invalid signature', async () => {
    const created = await prepaidOrder()
    rzp.setPaymentAmount(created.amount)
    const res = await request(app)
      .post('/api/payments/verify')
      .send({
        orderNumber: created.orderNumber,
        razorpayOrderId: created.razorpayOrderId,
        razorpayPaymentId: 'pay_test_bad',
        razorpaySignature: 'deadbeef',
      })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'PAYMENT_VERIFICATION_FAILED')
    const order = await Order.findOne({ orderNumber: created.orderNumber }).lean()
    assert.notEqual(order.status, 'CONFIRMED')
  })

  it('rejects when the captured amount differs from the server total', async () => {
    const created = await prepaidOrder()
    rzp.setPaymentAmount(created.amount - 100)
    const res = await request(app)
      .post('/api/payments/verify')
      .send({
        orderNumber: created.orderNumber,
        razorpayOrderId: created.razorpayOrderId,
        razorpayPaymentId: 'pay_test_short',
        razorpaySignature: paymentSignature(created.razorpayOrderId, 'pay_test_short'),
      })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /amount mismatch/i)
  })

  it('rejects a Razorpay order id that does not belong to the order', async () => {
    const created = await prepaidOrder()
    const res = await request(app)
      .post('/api/payments/verify')
      .send({
        orderNumber: created.orderNumber,
        razorpayOrderId: 'order_someone_else',
        razorpayPaymentId: 'pay_x',
        razorpaySignature: paymentSignature('order_someone_else', 'pay_x'),
      })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /mismatch/i)
  })
})

describe('POST /api/webhooks/razorpay', () => {
  function capturedEvent(created, eventId) {
    return JSON.stringify({
      event: 'payment.captured',
      event_id: eventId,
      payload: {
        payment: {
          entity: {
            id: 'pay_webhook_1',
            order_id: created.razorpayOrderId,
            amount: created.amount,
            method: 'upi',
          },
        },
      },
    })
  }

  it('confirms the order for a correctly signed event and is idempotent on replay', async () => {
    const created = await prepaidOrder()
    const raw = capturedEvent(created, 'evt_1')
    const sig = hmacHex(TEST_SECRETS.razorpayWebhookSecret, raw)

    const first = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(raw)
    assert.equal(first.status, 200)
    assert.equal(first.body.data.duplicate, false)

    const order = await Order.findOne({ orderNumber: created.orderNumber }).lean()
    assert.equal(order.status, 'CONFIRMED')
    assert.equal(order.paymentStatus, 'PAID')
    assert.equal(order.pricing.totalPaise, 60800)

    const replay = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(raw)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.data.duplicate, true)
  })

  it('rejects an event with an invalid signature', async () => {
    const created = await prepaidOrder()
    const raw = capturedEvent(created, 'evt_2')
    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', hmacHex('wrong-secret', raw))
      .send(raw)
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'INVALID_WEBHOOK')
    const order = await Order.findOne({ orderNumber: created.orderNumber }).lean()
    assert.notEqual(order.status, 'CONFIRMED')
  })
})
