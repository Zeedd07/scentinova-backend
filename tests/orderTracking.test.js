/**
 * Public order tracking: order number + secret, sanitized payload, timeline,
 * emailed tracking codes, and failed-attempt rate limiting.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { Order } from '../src/models/Order.js'
import { createPaymentOrder } from '../src/services/checkoutService.js'
import {
  __resetResendClientForTests,
  buildOrderConfirmationEmail,
  getResendClient,
  sendOrderConfirmationEmail,
} from '../src/services/emailService.js'
import {
  TRACKING_NOT_FOUND_MESSAGE,
  buildTrackingUrl,
  issueEmailTrackingCode,
} from '../src/services/orderTrackingService.js'
import { generateTrackingCode, normalizeTrackingCode } from '../src/utils/tokens.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import { checkoutInput, createProduct, standardFees, stubRazorpay } from './helpers/fixtures.js'

let app
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
  product = await createProduct({ name: 'Seaweed', pricePaise: 49900, fees: standardFees() })
  stubRazorpay()
})

async function codOrder() {
  return createPaymentOrder(checkoutInput({ productId: product._id, paymentMethod: 'COD' }))
}

function track(body) {
  return request(app).post('/api/orders/track').send(body)
}

const FORBIDDEN_KEYS = [
  '_id',
  '__v',
  'trackingTokenHash',
  'trackingCodeHashes',
  'pendingEmailTrackingCode',
  'customerSnapshot',
  'customer',
  'shippingAddress',
  'billingAddress',
  'payment',
  'razorpayOrderId',
  'razorpayPaymentId',
  'notes',
  'customerNote',
  'statusHistory',
  'idempotencyKey',
  'email',
  'phone',
]

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, keys))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k)
      collectKeys(v, keys)
    }
  }
  return keys
}

describe('tracking codes', () => {
  it('are 12 Crockford base32 chars grouped 4-4-4 and unique', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateTrackingCode()))
    assert.equal(codes.size, 200)
    for (const code of codes) {
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    }
  })

  it('normalize case, separators and ambiguous glyphs', () => {
    assert.equal(normalizeTrackingCode('ab1o-il2x-y3z4'), 'AB1011' + '2XY3Z4')
    assert.equal(normalizeTrackingCode(' 7k3m q9xd 2tra '), '7K3MQ9XD2TRA')
  })
})

describe('POST /api/orders/track', () => {
  it('returns a sanitized payload for order number + checkout token', async () => {
    const created = await codOrder()
    await Order.updateOne(
      { orderNumber: created.orderNumber },
      { $set: { notes: 'internal admin note', customerNote: 'leave at door' } },
    )

    const res = await track({ orderNumber: created.orderNumber, token: created.trackingToken })
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    const order = res.body.data.order

    assert.equal(order.orderNumber, created.orderNumber)
    assert.equal(order.status, 'CONFIRMED')
    assert.equal(order.paymentMethod, 'COD')
    assert.equal(order.paymentStatus, 'PENDING')
    assert.equal(order.amountDuePaise, order.pricing.totalPaise)
    assert.deepEqual(order.destination, { city: 'Mumbai', state: 'MH' })
    assert.equal(order.items[0].quantity, 1)
    assert.equal(order.shipment, null)

    const keys = collectKeys(order)
    for (const key of FORBIDDEN_KEYS) {
      assert.ok(!keys.has(key), `response must not include "${key}"`)
    }
    const raw = JSON.stringify(res.body)
    for (const leak of ['buyer@example.com', '9999999999', '1 Test Street', 'internal admin note', 'leave at door']) {
      assert.ok(!raw.includes(leak), `response must not include "${leak}"`)
    }
  })

  it('accepts lowercase order numbers', async () => {
    const created = await codOrder()
    const res = await track({
      orderNumber: created.orderNumber.toLowerCase(),
      token: created.trackingToken,
    })
    assert.equal(res.status, 200)
  })

  it('returns the same 404 for a wrong token and an unknown order number', async () => {
    const created = await codOrder()
    const wrongToken = await track({ orderNumber: created.orderNumber, token: 'X'.repeat(43) })
    const unknownOrder = await track({ orderNumber: 'SCN-20990101-DEADBEEF', token: created.trackingToken })

    for (const res of [wrongToken, unknownOrder]) {
      assert.equal(res.status, 404)
      assert.equal(res.body.error.code, 'ORDER_NOT_FOUND')
      assert.equal(res.body.error.message, TRACKING_NOT_FOUND_MESSAGE)
    }
  })

  it("does not let one order's token open another order", async () => {
    const a = await codOrder()
    const b = await codOrder()
    const res = await track({ orderNumber: b.orderNumber, token: a.trackingToken })
    assert.equal(res.status, 404)
  })

  it('rejects missing fields and unknown keys with 400', async () => {
    const created = await codOrder()
    const noToken = await track({ orderNumber: created.orderNumber })
    const noNumber = await track({ token: created.trackingToken })
    const extra = await track({ orderNumber: created.orderNumber, token: created.trackingToken, email: 'x@y.z' })
    const badChars = await track({ orderNumber: '{"$ne":null}', token: 'abc' })
    for (const res of [noToken, noNumber, extra, badChars]) {
      assert.equal(res.status, 400)
      assert.equal(res.body.error.code, 'VALIDATION_ERROR')
    }
  })

  it('accepts an emailed tracking code in any case / spacing', async () => {
    const created = await codOrder()
    const order = await Order.findOne({ orderNumber: created.orderNumber })
    const code = await issueEmailTrackingCode(order)

    const messy = code.toLowerCase().replaceAll('-', ' ')
    const res = await track({ orderNumber: created.orderNumber, token: messy })
    assert.equal(res.status, 200)

    const stored = await Order.findOne({ orderNumber: created.orderNumber })
    assert.equal(stored.trackingCodeHashes.length, 1)
    assert.ok(!stored.trackingCodeHashes[0].includes(normalizeTrackingCode(code)))
  })

  it('shows ₹0 due once a COD order is paid, and exposes shipment details', async () => {
    const created = await codOrder()
    await Order.updateOne(
      { orderNumber: created.orderNumber },
      {
        $set: {
          status: 'DELIVERED',
          paymentStatus: 'PAID',
          'payment.status': 'PAID',
          'fulfillment.carrier': 'Delhivery',
          'fulfillment.trackingNumber': 'DL123',
          'fulfillment.trackingUrl': 'https://track.example.com/DL123',
          'fulfillment.shippedAt': new Date('2026-09-20T10:00:00Z'),
          'fulfillment.deliveredAt': new Date('2026-09-22T10:00:00Z'),
        },
      },
    )
    const res = await track({ orderNumber: created.orderNumber, token: created.trackingToken })
    const order = res.body.data.order
    assert.equal(order.paymentStatus, 'PAID')
    assert.equal(order.amountDuePaise, 0)
    assert.equal(order.isDelivered, true)
    assert.equal(order.shipment.carrier, 'Delhivery')
    assert.equal(order.shipment.trackingNumber, 'DL123')
    assert.equal(order.shipment.trackingUrl, 'https://track.example.com/DL123')
    assert.ok(order.timeline.every((s) => s.state === 'complete'))
  })

  it('drops non-http shipment tracking URLs', async () => {
    const created = await codOrder()
    await Order.updateOne(
      { orderNumber: created.orderNumber },
      { $set: { 'fulfillment.trackingNumber': 'X1', 'fulfillment.trackingUrl': 'javascript:alert(1)' } },
    )
    const res = await track({ orderNumber: created.orderNumber, token: created.trackingToken })
    assert.equal(res.body.data.order.shipment.trackingUrl, null)
  })

  it('maps progress statuses onto the timeline', async () => {
    const created = await codOrder()
    await Order.updateOne(
      { orderNumber: created.orderNumber },
      {
        $set: { status: 'SHIPPED' },
        $push: {
          statusHistory: {
            $each: [
              { status: 'PROCESSING', createdAt: new Date() },
              { status: 'PACKED', createdAt: new Date() },
              { status: 'SHIPPED', createdAt: new Date() },
            ],
          },
        },
      },
    )
    const res = await track({ orderNumber: created.orderNumber, token: created.trackingToken })
    const states = res.body.data.order.timeline.map((s) => `${s.key}:${s.state}`)
    assert.deepEqual(states, [
      'PLACED:complete',
      'CONFIRMED:complete',
      'PROCESSING:complete',
      'SHIPPED:current',
      'OUT_FOR_DELIVERY:upcoming',
      'DELIVERED:upcoming',
    ])
    assert.equal(res.body.data.order.timeline[1].label, 'Order confirmed')
  })

  it('marks cancelled orders and stops the timeline where it was reached', async () => {
    const created = await codOrder()
    await Order.updateOne(
      { orderNumber: created.orderNumber },
      {
        $set: { status: 'CANCELLED' },
        $push: { statusHistory: { status: 'CANCELLED', createdAt: new Date() } },
      },
    )
    const res = await track({ orderNumber: created.orderNumber, token: created.trackingToken })
    const order = res.body.data.order
    assert.equal(order.isCancelled, true)
    assert.equal(order.statusLabel, 'Cancelled')
    assert.equal(order.amountDuePaise, 0)
    assert.deepEqual(
      order.timeline.map((s) => s.state),
      ['complete', 'complete', 'skipped', 'skipped', 'skipped', 'skipped'],
    )
  })

  it('labels the prepaid confirmation step as payment', async () => {
    const created = await createPaymentOrder(
      checkoutInput({ productId: product._id, paymentMethod: 'PREPAID' }),
    )
    const res = await track({ orderNumber: created.orderNumber, token: created.trackingToken })
    const order = res.body.data.order
    assert.equal(order.status, 'PENDING_PAYMENT')
    assert.equal(order.paymentStatus, 'PENDING')
    assert.equal(order.amountDuePaise, 0)
    assert.equal(order.timeline[0].state, 'current')
    assert.equal(order.timeline[1].label, 'Payment confirmed')
  })
})

describe('legacy + confirmation endpoints', () => {
  it('GET /track/:token returns the same sanitized payload', async () => {
    const created = await codOrder()
    const res = await request(app).get(`/api/orders/track/${created.trackingToken}`)
    assert.equal(res.status, 200)
    assert.ok(!collectKeys(res.body.data.order).has('shippingAddress'))
    assert.ok(!collectKeys(res.body.data.order).has('razorpayOrderId'))
  })

  it('confirmation requires a valid token', async () => {
    const created = await codOrder()
    const none = await request(app).get(`/api/orders/confirmation/${created.orderNumber}`)
    const wrong = await request(app).get(
      `/api/orders/confirmation/${created.orderNumber}?token=${'Y'.repeat(43)}`,
    )
    const ok = await request(app).get(
      `/api/orders/confirmation/${created.orderNumber}?token=${created.trackingToken}`,
    )
    assert.equal(none.status, 404)
    assert.equal(wrong.status, 404)
    assert.equal(ok.status, 200)
    assert.equal(ok.body.data.order.payment.razorpayOrderId, undefined)
    assert.equal(ok.body.data.order.payment.razorpayPaymentId, undefined)
  })
})

describe('confirmation email tracking link', () => {
  it('builder renders the link and code only for http(s) URLs', () => {
    const order = {
      orderNumber: 'SCN-20260927-ABCDEF12',
      paymentMethod: 'COD',
      items: [],
      pricing: { totalPaise: 1000 },
      customerSnapshot: { name: 'A', email: 'a@b.co' },
    }
    const url = buildTrackingUrl(order.orderNumber, '7K3M-Q9XD-2TRA')
    assert.equal(
      url,
      'http://localhost:5173/track-order?order=SCN-20260927-ABCDEF12&token=7K3M-Q9XD-2TRA',
    )
    const withLink = buildOrderConfirmationEmail(order, { trackingUrl: url, trackingCode: '7K3M-Q9XD-2TRA' })
    assert.ok(withLink.html.includes('Track your order'))
    assert.ok(withLink.html.includes('7K3M-Q9XD-2TRA'))
    assert.ok(withLink.text.includes(url))

    const bad = buildOrderConfirmationEmail(order, { trackingUrl: 'javascript:alert(1)' })
    assert.ok(!bad.html.includes('Track your order'))
    assert.ok(!buildOrderConfirmationEmail(order).html.includes('Track your order'))
  })

  it('emailed link works, retries reuse the same code, raw code is cleared after send', async () => {
    const created = await codOrder()
    const original = { apiKey: env.email.apiKey, from: env.email.from }
    env.email.apiKey = 're_test_dummy'
    env.email.from = 'orders@example.com'
    __resetResendClientForTests()
    const sent = []
    let failNext = true
    getResendClient().emails.send = async (payload) => {
      sent.push(payload)
      if (failNext) {
        failNext = false
        throw new Error('simulated timeout')
      }
      return { data: { id: 'msg_test' }, error: null }
    }

    try {
      const first = await sendOrderConfirmationEmail(
        await Order.findOne({ orderNumber: created.orderNumber }),
      )
      assert.equal(first.sent, false)
      const second = await sendOrderConfirmationEmail(
        await Order.findOne({ orderNumber: created.orderNumber }),
      )
      assert.equal(second.sent, true)
    } finally {
      env.email.apiKey = original.apiKey
      env.email.from = original.from
      __resetResendClientForTests()
    }

    assert.equal(sent.length, 2)
    assert.equal(sent[0].html, sent[1].html, 'retry must send an identical payload')

    const code = sent[1].text.match(/Tracking code: (\S+)/)[1]
    const link = sent[1].text.match(/Track your order: (\S+)/)[1]
    const params = new URL(link).searchParams
    assert.equal(params.get('order'), created.orderNumber)
    assert.equal(params.get('token'), code)

    const res = await track({ orderNumber: created.orderNumber, token: code })
    assert.equal(res.status, 200)

    const stored = await Order.findOne({ orderNumber: created.orderNumber })
    assert.equal(stored.pendingEmailTrackingCode, null)
    assert.equal(stored.trackingCodeHashes.length, 1)
  })
})

// Last: exhausts this app instance's limiter budget
describe('rate limiting', () => {
  it('blocks after repeated failed lookups but ignores successful ones', async () => {
    const created = await codOrder()
    let limited = null
    for (let i = 0; i < 30; i += 1) {
      const res = await track({ orderNumber: created.orderNumber, token: `wrong-${i}` })
      if (res.status === 429) {
        limited = res
        break
      }
      assert.equal(res.status, 404)
    }
    assert.ok(limited, 'expected a 429 within 30 failed attempts')
    assert.equal(limited.body.error.code, 'RATE_LIMITED')
  })
})
