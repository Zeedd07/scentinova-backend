/**
 * Checkout takes the street address as three required parts (flat/house no., building,
 * street/area) plus an optional landmark, and still accepts the older single-line format.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { createPaymentOrder } from '../src/services/checkoutService.js'
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

const PARTS = { houseNumber: 'Flat 12B', building: 'Rose Apartments', area: 'MG Road, Andheri West' }

/** COD checkout body with the given street fields in place of the fixture's addressLine1. */
function withStreet(street) {
  const input = checkoutInput({ productId: product._id, paymentMethod: 'COD' })
  const { addressLine1: _legacy, ...rest } = input.shippingAddress
  input.shippingAddress = { ...rest, ...street }
  return input
}

function checkout(body) {
  return request(app).post('/api/checkout/create-payment-order').send(body)
}

describe('structured shipping address', () => {
  it('stores each part, tidies spacing and builds the address lines', async () => {
    const res = await checkout(
      withStreet({
        houseNumber: '  Flat   12B ',
        building: 'Rose  Apartments',
        area: ' MG Road, Andheri West ',
        landmark: '  Opposite City Mall ',
      }),
    )
    assert.equal(res.status, 201)
    const order = await Order.findOne({ orderNumber: res.body.data.orderNumber }).lean()
    const a = order.shippingAddress
    assert.equal(a.houseNumber, 'Flat 12B')
    assert.equal(a.building, 'Rose Apartments')
    assert.equal(a.area, 'MG Road, Andheri West')
    assert.equal(a.landmark, 'Opposite City Mall')
    assert.equal(a.addressLine1, 'Flat 12B, Rose Apartments')
    assert.equal(a.addressLine2, 'MG Road, Andheri West')
    assert.equal(a.line1, a.addressLine1)
    assert.equal(a.city, 'Mumbai')
  })

  it('treats the landmark as optional', async () => {
    for (const landmark of [undefined, null, '', '   ']) {
      await clearTestDb()
      product = await createProduct({ name: 'Seaweed', pricePaise: 49900, fees: standardFees() })
      const res = await checkout(withStreet({ ...PARTS, landmark }))
      assert.equal(res.status, 201, String(landmark))
      const order = await Order.findOne({ orderNumber: res.body.data.orderNumber }).lean()
      assert.equal(order.shippingAddress.landmark, null)
    }
  })

  it('requires flat/house no., building and street/area, with an error on each missing field', async () => {
    const messages = {
      houseNumber: 'Enter your flat, house or room number.',
      building: 'Enter your building or house name.',
      area: 'Enter your street, area or locality.',
    }
    for (const missing of Object.keys(messages)) {
      for (const blank of [undefined, '', '    ']) {
        const res = await checkout(withStreet({ ...PARTS, [missing]: blank }))
        assert.equal(res.status, 400, `${missing}=${JSON.stringify(blank)}`)
        assert.equal(res.body.error.code, 'VALIDATION_ERROR')
        assert.equal(res.body.error.fields[`shippingAddress.${missing}`], messages[missing])
        for (const other of Object.keys(messages).filter((k) => k !== missing)) {
          assert.equal(res.body.error.fields[`shippingAddress.${other}`], undefined)
        }
      }
    }
    assert.equal(await Order.countDocuments(), 0)
  })

  it('flags all three fields when no street address is sent', async () => {
    const res = await checkout(withStreet({ landmark: 'Near the park' }))
    assert.equal(res.status, 400)
    assert.ok(res.body.error.fields['shippingAddress.houseNumber'])
    assert.ok(res.body.error.fields['shippingAddress.building'])
    assert.ok(res.body.error.fields['shippingAddress.area'])
    assert.equal(await Order.countDocuments(), 0)
  })

  it('rejects parts longer than 120 characters', async () => {
    for (const key of ['houseNumber', 'building', 'area', 'landmark']) {
      const res = await checkout(withStreet({ ...PARTS, [key]: 'x'.repeat(121) }))
      assert.equal(res.status, 400, key)
      assert.match(res.body.error.fields[`shippingAddress.${key}`], /120 characters/)
    }
    assert.equal(await Order.countDocuments(), 0)
  })

  it('still accepts the single-line address from older storefront builds', async () => {
    const res = await checkout(checkoutInput({ productId: product._id, paymentMethod: 'COD' }))
    assert.equal(res.status, 201)
    const order = await Order.findOne({ orderNumber: res.body.data.orderNumber }).lean()
    assert.equal(order.shippingAddress.addressLine1, '1 Test Street')
    assert.equal(order.shippingAddress.houseNumber, null)
  })

  it('rejects a partial structured address even without the HTTP validator', async () => {
    await assert.rejects(
      createPaymentOrder(withStreet({ houseNumber: 'Flat 12B', area: 'MG Road' })),
      (err) => err.statusCode === 400 && err.code === 'INVALID_ADDRESS',
    )
    assert.equal(await Order.countDocuments(), 0)
  })
})
