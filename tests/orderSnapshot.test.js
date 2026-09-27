/**
 * Orders are priced once and keep an immutable snapshot; later product fee changes
 * must never alter historical orders or their confirmation emails.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { Product } from '../src/models/Product.js'
import { createPaymentOrder, toCustomerOrder } from '../src/services/checkoutService.js'
import { buildOrderConfirmationEmail } from '../src/services/emailService.js'
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

async function setFees(overrides) {
  await Product.updateOne({ _id: product._id }, { $set: { fees: standardFees(overrides) } })
}

async function placeOrder(paymentMethod) {
  const res = await createPaymentOrder(checkoutInput({ productId: product._id, paymentMethod }))
  return Order.findOne({ orderNumber: res.orderNumber })
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
  product = await createProduct({ name: 'Seaweed', pricePaise: 49900, fees: standardFees() })
  stubRazorpay()
})

describe('pricing snapshot on orders', () => {
  it('stores the full pricing breakdown and the per-product fee snapshot', async () => {
    const order = await placeOrder('COD')
    assert.deepEqual(
      {
        subtotalPaise: order.pricing.subtotalPaise,
        discountPaise: order.pricing.discountPaise,
        shippingPaise: order.pricing.shippingPaise,
        convenienceFeePaise: order.pricing.convenienceFeePaise,
        codFeePaise: order.pricing.codFeePaise,
        totalPaise: order.pricing.totalPaise,
        configVersion: order.pricing.configVersion,
      },
      {
        subtotalPaise: 49900,
        discountPaise: 0,
        shippingPaise: 9900,
        convenienceFeePaise: 1000,
        codFeePaise: 8500,
        totalPaise: 69300,
        configVersion: null,
      },
    )
    assert.equal(order.pricingSnapshot.feeModel, 'PER_PRODUCT')
    assert.equal(order.pricingSnapshot.lines.length, 1)
    const [snap] = order.pricingSnapshot.lines
    assert.equal(String(snap.productId), String(product._id))
    assert.equal(snap.convenienceFeePaise, 1000)
    assert.equal(snap.codFeePaise, 8500)
    assert.equal(snap.shippingFeePaise, 9900)
    assert.equal(snap.codAllowed, true)
  })

  it('changing product fees does not change old orders; new orders use the new fees', async () => {
    const oldCod = await placeOrder('COD')
    const oldPrepaid = await placeOrder('PREPAID')

    await setFees({
      shipping: { amountPaise: 14900 },
      cod: { amountPaise: 9900 },
      convenience: { amountPaise: 1500 },
    })

    const reloadedCod = await Order.findById(oldCod._id).lean()
    const reloadedPrepaid = await Order.findById(oldPrepaid._id).lean()
    assert.equal(reloadedCod.pricing.shippingPaise, 9900)
    assert.equal(reloadedCod.pricing.codFeePaise, 8500)
    assert.equal(reloadedCod.pricing.convenienceFeePaise, 1000)
    assert.equal(reloadedCod.pricing.totalPaise, 69300)
    assert.equal(reloadedCod.pricingSnapshot.lines[0].codFeePaise, 8500)
    assert.equal(reloadedPrepaid.pricing.totalPaise, 60800)
    assert.equal(reloadedPrepaid.payment.amountPaise, 60800)

    // Admin + customer views read the stored values
    const adminView = await request(app)
      .get(`/api/admin/orders/${oldCod._id}`)
      .set('Authorization', `Bearer ${token}`)
    assert.equal(adminView.status, 200)
    assert.equal(adminView.body.data.order.pricing.shippingPaise, 9900)
    assert.equal(adminView.body.data.order.pricing.totalPaise, 69300)
    assert.equal(toCustomerOrder(reloadedCod).pricing.totalPaise, 69300)

    const newCod = await placeOrder('COD')
    assert.equal(newCod.pricing.shippingPaise, 14900)
    assert.equal(newCod.pricing.codFeePaise, 9900)
    assert.equal(newCod.pricing.convenienceFeePaise, 1500)
    assert.equal(newCod.pricing.totalPaise, 49900 + 14900 + 1500 + 9900)

    const newPrepaid = await placeOrder('PREPAID')
    assert.equal(newPrepaid.pricing.shippingPaise, 14900)
    assert.equal(newPrepaid.pricing.codFeePaise, 0)
    assert.equal(newPrepaid.pricing.totalPaise, 49900 + 14900 + 1500)
  })

  it('disallowing COD on a product leaves existing COD orders untouched and visible to admin', async () => {
    const cod = await placeOrder('COD')
    await setFees({ codAllowed: false })

    const list = await request(app).get('/api/admin/orders').set('Authorization', `Bearer ${token}`)
    assert.equal(list.status, 200)
    const listed = list.body.data.orders.find((o) => o.orderNumber === cod.orderNumber)
    assert.ok(listed)
    assert.equal(listed.paymentMethod, 'COD')
    assert.equal(listed.pricing.totalPaise, 69300)

    const markPaid = await request(app)
      .post(`/api/admin/orders/${cod._id}/mark-cod-paid`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    assert.equal(markPaid.status, 200)
    const after = await Order.findById(cod._id).lean()
    assert.equal(after.pricing.totalPaise, 69300)
  })

  it('orders priced by the old global settings keep their legacy snapshot', async () => {
    const { insertedId } = await Order.collection.insertOne({
      orderNumber: 'SN-GLOBAL-1',
      status: 'CONFIRMED',
      paymentMethod: 'COD',
      customerSnapshot: { name: 'Old Buyer', email: 'old@example.com' },
      items: [
        { name: 'Seaweed', quantity: 1, unitPricePaise: 49900, subtotalPaise: 49900, totalPaise: 49900 },
      ],
      pricing: {
        subtotalPaise: 49900,
        shippingPaise: 9900,
        convenienceFeePaise: 1000,
        codFeePaise: 8500,
        totalPaise: 69300,
        configVersion: 3,
      },
      pricingSnapshot: {
        settingsVersion: 3,
        shippingEnabled: true,
        shippingStandardFeePaise: 9900,
        codFeeEnabled: true,
        codFeeConfiguredPaise: 8500,
      },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    })

    const res = await request(app)
      .get(`/api/admin/orders/${insertedId}`)
      .set('Authorization', `Bearer ${token}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.order.pricing.totalPaise, 69300)
    assert.equal(res.body.data.order.pricing.configVersion, 3)
    const doc = await Order.findById(insertedId)
    assert.equal(doc.pricingSnapshot.settingsVersion, 3)
    assert.equal(doc.pricingSnapshot.codFeeConfiguredPaise, 8500)
    assert.equal(doc.pricingSnapshot.lines, undefined)
  })

  it('legacy orders without the new fields are shown as stored, never recalculated', async () => {
    const { insertedId } = await Order.collection.insertOne({
      orderNumber: 'SN-LEGACY-1',
      status: 'CONFIRMED',
      paymentMethod: 'PREPAID',
      customerSnapshot: { name: 'Old Buyer', email: 'old@example.com' },
      items: [
        { name: 'Seaweed', quantity: 1, unitPricePaise: 49900, subtotalPaise: 49900, totalPaise: 49900 },
      ],
      pricing: { subtotalPaise: 49900, shippingPaise: 0, totalPaise: 49900 },
      total: 499,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    })
    await setFees({ shipping: { amountPaise: 14900 } })

    const res = await request(app)
      .get(`/api/admin/orders/${insertedId}`)
      .set('Authorization', `Bearer ${token}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.order.pricing.totalPaise, 49900)
    assert.equal(res.body.data.order.pricing.shippingPaise, 0)
    assert.equal(res.body.data.order.pricingSnapshot ?? null, null)
    const raw = await Order.collection.findOne({ _id: insertedId })
    assert.equal(raw.pricing.totalPaise, 49900)
    assert.equal(raw.pricingSnapshot, undefined)
  })
})

describe('confirmation email uses the stored order pricing', () => {
  it('prepaid email shows the stored fees even after product fees change', async () => {
    const order = await placeOrder('PREPAID')
    await setFees({ shipping: { amountPaise: 14900 }, convenience: { amountPaise: 1500 } })

    const stored = await Order.findById(order._id).lean()
    const email = buildOrderConfirmationEmail(stored)
    assert.equal(email.pricing.shippingPaise, 9900)
    assert.equal(email.pricing.convenienceFeePaise, 1000)
    assert.equal(email.pricing.codFeePaise, 0)
    assert.equal(email.pricing.totalPaise, 60800)
    assert.equal(email.display.total, 608)
    assert.equal(email.html.includes('149'), false)
  })

  it('COD email shows the stored COD + convenience fees even after product fees change', async () => {
    const order = await placeOrder('COD')
    await setFees({ cod: { amountPaise: 9900 }, convenience: { amountPaise: 1500 } })

    const stored = await Order.findById(order._id).lean()
    const email = buildOrderConfirmationEmail(stored)
    assert.equal(email.pricing.codFeePaise, 8500)
    assert.equal(email.pricing.convenienceFeePaise, 1000)
    assert.equal(email.pricing.totalPaise, 69300)
    assert.equal(email.display.codFee, 85)
    assert.equal(email.display.total, 693)
    assert.ok(email.html.includes('Amount payable on delivery'))
  })

  it('order history and email payload are identical before and after a fee change', async () => {
    const order = await placeOrder('COD')
    const before = buildOrderConfirmationEmail(await Order.findById(order._id).lean())
    await setFees({
      shipping: { amountPaise: 19900 },
      cod: { amountPaise: 12000 },
      convenience: { enabled: false },
    })
    const afterEmail = buildOrderConfirmationEmail(await Order.findById(order._id).lean())
    assert.deepEqual(afterEmail.pricing, before.pricing)
    assert.deepEqual(afterEmail.display, before.display)
    assert.equal(afterEmail.html, before.html)
  })
})
