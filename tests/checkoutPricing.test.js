/**
 * Server-authoritative checkout pricing driven by per-product fees.
 * Service-level calls keep us under the per-IP order rate limiter; a few HTTP
 * calls prove the routes ignore client-supplied fees/totals.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { Product } from '../src/models/Product.js'
import { quoteCart, createPaymentOrder } from '../src/services/checkoutService.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import {
  checkoutInput,
  createProduct,
  seedLegacySettings,
  standardFees,
  stubRazorpay,
} from './helpers/fixtures.js'

let app
let product
let rzp

async function setFees(overrides, target = product) {
  await Product.updateOne({ _id: target._id }, { $set: { fees: standardFees(overrides) } })
}

function quote(paymentMethod, productId = product._id, quantity = 1) {
  return quoteCart({ items: [{ productId: String(productId), quantity }], paymentMethod })
}

async function rejectsWith(promise, statusCode, code) {
  await assert.rejects(promise, (err) => err.statusCode === statusCode && err.code === code)
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

describe('prepaid pricing', () => {
  it('ships free, keeps the convenience fee and never charges a COD fee (₹509)', async () => {
    const q = await quote('PREPAID')
    assert.equal(q.pricing.subtotalPaise, 49900)
    assert.equal(q.pricing.shippingPaise, 0)
    assert.equal(q.pricing.convenienceFeePaise, 1000)
    assert.equal(q.pricing.codFeePaise, 0)
    assert.equal(q.pricing.discountPaise, 0)
    assert.equal(q.pricing.totalPaise, 50900)
    assert.equal(q.paymentMethod, 'PREPAID')
  })

  it('follows admin changes to the product fees, still shipping free', async () => {
    await setFees({ shipping: { amountPaise: 14900 }, convenience: { amountPaise: 1500 } })
    const q = await quote('PREPAID')
    assert.equal(q.pricing.shippingPaise, 0)
    assert.equal(q.pricing.convenienceFeePaise, 1500)
    assert.equal(q.pricing.totalPaise, 49900 + 1500)
  })

  it('omits convenience fee when disabled or not applied to prepaid', async () => {
    await setFees({ convenience: { applyToPrepaid: false } })
    assert.equal((await quote('PREPAID')).pricing.convenienceFeePaise, 0)
    assert.equal((await quote('COD')).pricing.convenienceFeePaise, 1000)
    await setFees({ convenience: { enabled: false } })
    assert.equal((await quote('PREPAID')).pricing.convenienceFeePaise, 0)
    assert.equal((await quote('COD')).pricing.convenienceFeePaise, 0)
  })
})

describe('COD pricing', () => {
  it('uses the product shipping, convenience and COD fee (₹693)', async () => {
    const q = await quote('COD')
    assert.equal(q.pricing.shippingPaise, 9900)
    assert.equal(q.pricing.convenienceFeePaise, 1000)
    assert.equal(q.pricing.codFeePaise, 8500)
    assert.equal(q.pricing.totalPaise, 69300)
  })

  it('charges ₹0 COD fee when the product COD fee is off', async () => {
    await setFees({ cod: { enabled: false } })
    const q = await quote('COD')
    assert.equal(q.pricing.codFeePaise, 0)
    assert.equal(q.pricing.totalPaise, 49900 + 9900 + 1000)
  })

  it('omits convenience fee on COD when applyToCod is off', async () => {
    await setFees({ convenience: { applyToCod: false } })
    const q = await quote('COD')
    assert.equal(q.pricing.convenienceFeePaise, 0)
    assert.equal(q.pricing.codFeePaise, 8500)
  })
})

describe('multi-product carts', () => {
  it('adds convenience/COD fees per product line, takes the highest shipping, ignores quantity', async () => {
    const other = await createProduct({
      name: 'Kaamdev',
      pricePaise: 79900,
      fees: standardFees({
        convenience: { amountPaise: 2000 },
        cod: { amountPaise: 4000 },
        shipping: { amountPaise: 14900 },
      }),
    })
    const q = await quoteCart({
      paymentMethod: 'COD',
      items: [
        { productId: String(product._id), quantity: 3 },
        { productId: String(other._id), quantity: 1 },
      ],
    })
    assert.equal(q.pricing.subtotalPaise, 49900 * 3 + 79900)
    assert.equal(q.pricing.convenienceFeePaise, 1000 + 2000)
    assert.equal(q.pricing.codFeePaise, 8500 + 4000)
    assert.equal(q.pricing.shippingPaise, 14900)
    assert.equal(q.pricing.totalPaise, 49900 * 3 + 79900 + 3000 + 12500 + 14900)
    assert.equal(q.pricingSnapshot.lines.length, 2)
  })

  it('legacy products without a fees field are priced with no fees', async () => {
    const { insertedId } = await Product.collection.insertOne({
      name: 'Legacy',
      slug: 'legacy-no-fees',
      sku: 'LEGACY-NO-FEES',
      pricePaise: 49900,
      price: 499,
      stock: 10,
      active: true,
      trackInventory: true,
    })
    const q = await quote('COD', insertedId)
    assert.equal(q.pricing.shippingPaise, 0)
    assert.equal(q.pricing.convenienceFeePaise, 0)
    assert.equal(q.pricing.codFeePaise, 0)
    assert.equal(q.pricing.totalPaise, 49900)
    const raw = await Product.collection.findOne({ _id: insertedId })
    assert.equal(raw.fees, undefined, 'quoting must not write fees onto legacy products')
  })

  it('ignores the old global PricingSettings document', async () => {
    await seedLegacySettings()
    await setFees({ shipping: { enabled: false }, convenience: { enabled: false }, cod: { enabled: false } })
    const q = await quote('COD')
    assert.equal(q.pricing.totalPaise, 49900)
  })
})

describe('COD availability (backend enforced per product)', () => {
  it('rejects COD on quote and order creation when a product disallows COD', async () => {
    await setFees({ codAllowed: false })
    await rejectsWith(quote('COD'), 400, 'PAYMENT_METHOD_DISABLED')
    await rejectsWith(
      createPaymentOrder(checkoutInput({ productId: product._id, paymentMethod: 'COD' })),
      400,
      'PAYMENT_METHOD_DISABLED',
    )
    assert.equal(await Order.countDocuments(), 0)

    const res = await request(app)
      .post('/api/checkout/create-payment-order')
      .send(checkoutInput({ productId: product._id, paymentMethod: 'COD' }))
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'PAYMENT_METHOD_DISABLED')
    assert.match(res.body.error.message, /Seaweed is not available for cash on delivery/)
    assert.equal(await Order.countDocuments(), 0)

    // Online payment still works and tells the UI which product blocks COD
    const q = await quote('PREPAID')
    assert.equal(q.pricing.totalPaise, 50900)
    assert.equal(q.paymentOptions.prepaid.enabled, true)
    assert.equal(q.paymentOptions.cod.enabled, false)
    assert.deepEqual(q.paymentOptions.cod.blockedBy, ['Seaweed'])
  })

  it('one COD-blocked product blocks COD for the whole cart', async () => {
    const blocked = await createProduct({
      name: 'Kaamdev',
      fees: standardFees({ codAllowed: false }),
    })
    await rejectsWith(
      quoteCart({
        paymentMethod: 'COD',
        items: [
          { productId: String(product._id), quantity: 1 },
          { productId: String(blocked._id), quantity: 1 },
        ],
      }),
      400,
      'PAYMENT_METHOD_DISABLED',
    )
  })

  it('returns COD fee and shipping hints in paymentOptions', async () => {
    const q = await quote('PREPAID')
    assert.deepEqual(q.paymentOptions.prepaid, {
      enabled: true,
      convenienceFeePaise: 1000,
      shippingPaise: 0,
    })
    assert.equal(q.paymentOptions.cod.enabled, true)
    assert.equal(q.paymentOptions.cod.codFeePaise, 8500)
    assert.equal(q.paymentOptions.cod.convenienceFeePaise, 1000)
    assert.equal(q.paymentOptions.cod.shippingPaise, 9900)
  })
})

describe('untrusted client input', () => {
  it('ignores client-supplied fee values and totals on /quote', async () => {
    const res = await request(app)
      .post('/api/checkout/quote')
      .send({
        items: [{ productId: String(product._id), quantity: 1 }],
        paymentMethod: 'COD',
        codFeePaise: 0,
        convenienceFeePaise: 0,
        shippingPaise: 0,
        totalPaise: 100,
        fees: { cod: { enabled: false }, convenience: { enabled: false } },
        lines: [{ productId: String(product._id), fees: {} }],
      })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.pricing.codFeePaise, 8500)
    assert.equal(res.body.data.pricing.convenienceFeePaise, 1000)
    assert.equal(res.body.data.pricing.shippingPaise, 9900)
    assert.equal(res.body.data.pricing.totalPaise, 69300)
    assert.equal(res.body.data.totalPaise, 69300)
  })

  it('ignores client totals/pricing on order creation', async () => {
    const res = await request(app)
      .post('/api/checkout/create-payment-order')
      .send(
        checkoutInput({
          productId: product._id,
          paymentMethod: 'COD',
          extra: { totalPaise: 100, amount: 100, pricing: { totalPaise: 100, codFeePaise: 0 } },
        }),
      )
    assert.equal(res.status, 201)
    const order = await Order.findOne({ orderNumber: res.body.data.orderNumber }).lean()
    assert.equal(order.pricing.totalPaise, 69300)
    assert.equal(order.pricing.codFeePaise, 8500)
  })

  it('rejects a client-expected total that differs from the server total', async () => {
    await rejectsWith(
      quoteCart({
        items: [{ productId: String(product._id), quantity: 1 }],
        paymentMethod: 'PREPAID',
        expectedTotalPaise: 50000,
      }),
      409,
      'PRICE_CHANGED',
    )
  })

  it('prices products from trusted DB data and rejects tampered unit prices', async () => {
    const q = await quote('PREPAID')
    assert.equal(q.items[0].unitPricePaise, 49900)
    await rejectsWith(
      quoteCart({
        items: [{ productId: String(product._id), quantity: 1, unitPricePaise: 100 }],
        paymentMethod: 'PREPAID',
      }),
      409,
      'PRICE_CHANGED',
    )
  })

  it('never exposes product fee configuration on public product endpoints', async () => {
    const res = await request(app).get(`/api/products/${product.slug}`)
    assert.equal(res.status, 200)
    const body = res.body.data.product || res.body.data
    assert.equal(body.fees, undefined)
  })
})

describe('Razorpay boundary', () => {
  it('creates the Razorpay order for exactly the server-calculated prepaid total', async () => {
    const res = await createPaymentOrder(
      checkoutInput({ productId: product._id, paymentMethod: 'PREPAID' }),
    )
    assert.equal(rzp.orderCalls.length, 1)
    assert.equal(rzp.orderCalls[0].amount, 50900)
    assert.equal(rzp.orderCalls[0].currency, 'INR')
    assert.equal(res.amount, 50900)
    const order = await Order.findOne({ orderNumber: res.orderNumber }).lean()
    assert.equal(order.pricing.totalPaise, 50900)
    assert.equal(order.pricing.shippingPaise, 0)
    assert.equal(order.payment.amountPaise, 50900)
    assert.equal(order.payment.razorpayOrderId, res.razorpayOrderId)
  })

  it('never calls Razorpay for COD', async () => {
    const res = await createPaymentOrder(
      checkoutInput({ productId: product._id, paymentMethod: 'COD' }),
    )
    assert.equal(rzp.orderCalls.length, 0)
    assert.equal(res.requiresRazorpay, false)
    assert.equal(res.razorpayOrderId, null)
    const order = await Order.findOne({ orderNumber: res.orderNumber }).lean()
    assert.equal(order.paymentMethod, 'COD')
    assert.equal(order.paymentStatus, 'PENDING')
    assert.equal(order.payment.provider, 'cod')
    assert.equal(order.payment.razorpayOrderId, undefined)
  })

  it('reprices a retried prepaid checkout when product fees changed since the first attempt', async () => {
    const input = checkoutInput({ productId: product._id, paymentMethod: 'PREPAID' })
    const first = await createPaymentOrder(input, { idempotencyKey: 'retry-key-1' })
    const again = await createPaymentOrder(input, { idempotencyKey: 'retry-key-1' })
    assert.equal(again.orderNumber, first.orderNumber)
    assert.equal(rzp.orderCalls.length, 1)

    await setFees({ convenience: { amountPaise: 1500 } })
    const repriced = await createPaymentOrder(input, { idempotencyKey: 'retry-key-1' })
    assert.notEqual(repriced.orderNumber, first.orderNumber)
    assert.equal(repriced.amount, 49900 + 1500)
    assert.equal(rzp.orderCalls.at(-1).amount, 51400)
  })
})

describe('legacy /checkout/options endpoint', () => {
  it('still responds with cart-independent defaults', async () => {
    const res = await request(app).get('/api/checkout/options')
    assert.equal(res.status, 200)
    assert.equal(res.body.data.paymentMethods.prepaid.enabled, true)
    assert.equal(res.body.data.paymentMethods.cod.enabled, true)
  })

  it('admin pricing settings routes are gone', async () => {
    const res = await request(app).get('/api/admin/settings/pricing')
    assert.ok([401, 404].includes(res.status))
  })
})
