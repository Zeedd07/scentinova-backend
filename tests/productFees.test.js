/**
 * Admin product create/update: per-product checkout fees are saved, validated,
 * returned to admins and hidden from the public catalogue.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Product } from '../src/models/Product.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import { createAdmin, createProduct, standardFees } from './helpers/fixtures.js'

let app
let token

const auth = () => ({ Authorization: `Bearer ${token}` })

function newProduct(extra = {}) {
  return { name: 'Oud Nocturne', price: 2499, stock: 10, ...extra }
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
})

describe('admin product fees', () => {
  it('creates a product with fees and returns them to the admin', async () => {
    const fees = standardFees({ codAllowed: false, convenience: { applyToCod: false } })
    const res = await request(app).post('/api/admin/products').set(auth()).send(newProduct({ fees }))
    assert.equal(res.status, 201)
    const saved = res.body.data.product.fees
    assert.equal(saved.shipping.amountPaise, 9900)
    assert.equal(saved.cod.amountPaise, 8500)
    assert.equal(saved.convenience.applyToCod, false)
    assert.equal(saved.codAllowed, false)
  })

  it('defaults to no fees and COD allowed when fees are omitted', async () => {
    const res = await request(app).post('/api/admin/products').set(auth()).send(newProduct())
    assert.equal(res.status, 201)
    const { fees } = res.body.data.product
    assert.equal(fees.convenience.enabled, false)
    assert.equal(fees.cod.enabled, false)
    assert.equal(fees.shipping.enabled, false)
    assert.equal(fees.codAllowed, true)
  })

  it('updates fees without touching other fields, and leaves fees alone on unrelated updates', async () => {
    const p = await createProduct({ name: 'Seaweed', fees: standardFees() })
    let res = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ fees: standardFees({ cod: { enabled: false }, shipping: { amountPaise: 4900 } }) })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.product.fees.cod.enabled, false)
    assert.equal(res.body.data.product.fees.shipping.amountPaise, 4900)
    assert.equal(res.body.data.product.name, 'Seaweed')

    res = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ tagline: 'Salt air' })
    assert.equal(res.status, 200)
    const stored = await Product.findById(p._id).lean()
    assert.equal(stored.fees.shipping.amountPaise, 4900)
    assert.equal(stored.fees.cod.enabled, false)
  })

  it('rejects negative, fractional or oversized fee amounts', async () => {
    for (const bad of [-100, 99.5, 1_000_001]) {
      const res = await request(app)
        .post('/api/admin/products')
        .set(auth())
        .send(newProduct({ name: `Bad ${bad}`, fees: standardFees({ cod: { amountPaise: bad } }) }))
      assert.equal(res.status, 400, `amount ${bad}`)
      assert.equal(res.body.error.code, 'VALIDATION_ERROR')
    }
    assert.equal(await Product.countDocuments(), 0)
  })

  it('requires admin auth to change fees', async () => {
    const p = await createProduct({ name: 'Seaweed' })
    const res = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .send({ fees: standardFees() })
    assert.equal(res.status, 401)
  })

  it('hides fees from public product list and detail responses', async () => {
    const p = await createProduct({ name: 'Seaweed', fees: standardFees() })
    const detail = await request(app).get(`/api/products/${p.slug}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.data.product.fees, undefined)
    const list = await request(app).get('/api/products')
    assert.equal(list.status, 200)
    assert.ok(list.body.data.products.every((x) => x.fees === undefined))
  })
})
