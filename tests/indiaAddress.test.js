/**
 * Checkout only accepts real Indian state/city combinations (same dataset as the
 * storefront dropdowns) and stores the canonical names in the order snapshot.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { createPaymentOrder } from '../src/services/checkoutService.js'
import { resolveIndiaAddress } from '../src/utils/indiaLocations.js'
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

function withAddress(address) {
  const input = checkoutInput({ productId: product._id, paymentMethod: 'COD' })
  input.shippingAddress = { ...input.shippingAddress, ...address }
  return input
}

function rejectsAddress(address, field) {
  assert.throws(
    () => resolveIndiaAddress({ country: 'India', ...address }),
    (err) => {
      assert.equal(err.statusCode, 400)
      assert.equal(err.code, 'INVALID_ADDRESS')
      assert.ok(err.fields[`shippingAddress.${field}`], `expected an error on ${field}`)
      return true
    },
  )
}

describe('resolveIndiaAddress', () => {
  it('accepts real state/city pairs and returns canonical names', () => {
    const pairs = [
      ['Maharashtra', 'Mumbai'],
      ['Maharashtra', 'Pune'],
      ['Maharashtra', 'Nashik'],
      ['Karnataka', 'Bengaluru'],
      ['Delhi', 'New Delhi'],
      ['Gujarat', 'Ahmedabad'],
      ['Tamil Nadu', 'Chennai'],
      ['West Bengal', 'Kolkata'],
    ]
    for (const [state, city] of pairs) {
      assert.deepEqual(resolveIndiaAddress({ country: 'India', state, city }), {
        country: 'India',
        state,
        city,
      })
    }
  })

  it('normalizes case, spacing and state codes', () => {
    assert.deepEqual(resolveIndiaAddress({ country: 'INDIA', state: '  maharashtra ', city: 'MUMBAI' }), {
      country: 'India',
      state: 'Maharashtra',
      city: 'Mumbai',
    })
    assert.equal(resolveIndiaAddress({ country: 'in', state: 'MH', city: 'navi   mumbai' }).city, 'Navi Mumbai')
    assert.equal(resolveIndiaAddress({ state: 'Karnataka', city: 'bengaluru' }).country, 'India')
  })

  it('rejects cities from another state, unknown cities and states, and other countries', () => {
    rejectsAddress({ state: 'Karnataka', city: 'Mumbai' }, 'city')
    rejectsAddress({ state: 'Maharashtra', city: 'MumbaiXYZ' }, 'city')
    rejectsAddress({ state: 'Maharashtra', city: 'Pune Division' }, 'city')
    rejectsAddress({ state: 'Maharashtra', city: '' }, 'city')
    rejectsAddress({ state: 'maharastra', city: 'Mumbai' }, 'state')
    rejectsAddress({ state: '', city: 'Mumbai' }, 'state')
    rejectsAddress({ country: 'USA', state: 'California', city: 'Los Angeles' }, 'country')
  })
})

describe('checkout address validation', () => {
  it('stores canonical names in the order snapshot', async () => {
    const created = await createPaymentOrder(withAddress({ state: 'maharashtra', city: 'mumbai', country: 'india' }))
    const order = await Order.findOne({ orderNumber: created.orderNumber }).lean()
    assert.equal(order.shippingAddress.city, 'Mumbai')
    assert.equal(order.shippingAddress.state, 'Maharashtra')
    assert.equal(order.shippingAddress.country, 'India')
    assert.equal(order.shippingAddress.postalCode, '400001')
  })

  it('rejects a stale city/state combination over HTTP without creating an order', async () => {
    const res = await request(app)
      .post('/api/checkout/create-payment-order')
      .send(withAddress({ state: 'Karnataka', city: 'Mumbai' }))
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'INVALID_ADDRESS')
    assert.match(res.body.error.fields['shippingAddress.city'], /Karnataka/)
    assert.equal(await Order.countDocuments(), 0)
  })

  it('rejects an invalid PIN code', async () => {
    for (const postalCode of ['40010A', '40010', '012345', '4000011']) {
      const res = await request(app)
        .post('/api/checkout/create-payment-order')
        .send(withAddress({ postalCode }))
      assert.equal(res.status, 400, postalCode)
      assert.equal(res.body.error.code, 'VALIDATION_ERROR')
      assert.equal(res.body.error.fields['shippingAddress.postalCode'], 'Enter a valid 6-digit PIN code.')
    }
    assert.equal(await Order.countDocuments(), 0)
  })
})
