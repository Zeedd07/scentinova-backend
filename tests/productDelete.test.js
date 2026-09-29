/**
 * Archive → restore, and permanent delete (blocked while a checkout holds stock).
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import mongoose from 'mongoose'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Product } from '../src/models/Product.js'
import { InventoryReservation } from '../src/models/InventoryReservation.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import { createAdmin, createProduct } from './helpers/fixtures.js'

let app
let token

const auth = () => ({ Authorization: `Bearer ${token}` })

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

function reserve(product, { status = 'ACTIVE', minutes = 10 } = {}) {
  return InventoryReservation.create({
    orderId: new mongoose.Types.ObjectId(),
    productId: product._id,
    quantity: 1,
    status,
    expiresAt: new Date(Date.now() + minutes * 60_000),
  })
}

describe('archive and restore', () => {
  it('archives, hides from the shop, then restores with active: true', async () => {
    const product = await createProduct({ name: 'Seaweed' })

    const archived = await request(app).delete(`/api/admin/products/${product._id}`).set(auth())
    assert.equal(archived.status, 200)
    assert.equal((await Product.findById(product._id)).active, false)
    const shop = await request(app).get('/api/products')
    assert.equal(shop.body.data.products.length, 0)

    const restored = await request(app)
      .patch(`/api/admin/products/${product._id}`)
      .set(auth())
      .send({ active: true })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.data.product.active, true)
    const shopAfter = await request(app).get('/api/products')
    assert.equal(shopAfter.body.data.products.length, 1)
  })
})

describe('permanent delete', () => {
  it('removes the product for good', async () => {
    const product = await createProduct({ name: 'Seaweed' })
    const res = await request(app).delete(`/api/admin/products/${product._id}/permanent`).set(auth())
    assert.equal(res.status, 200)
    assert.equal(res.body.data.deleted, true)
    assert.equal(await Product.exists({ _id: product._id }), null)
  })

  it('is blocked while a checkout holds stock, but not for finished or expired holds', async () => {
    const product = await createProduct({ name: 'Seaweed' })
    await reserve(product)

    const blocked = await request(app).delete(`/api/admin/products/${product._id}/permanent`).set(auth())
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'PRODUCT_IN_CHECKOUT')
    assert.ok(await Product.exists({ _id: product._id }))

    await InventoryReservation.deleteMany({})
    await reserve(product, { status: 'COMMITTED' })
    await reserve(product, { minutes: -5 })
    const ok = await request(app).delete(`/api/admin/products/${product._id}/permanent`).set(auth())
    assert.equal(ok.status, 200)
  })

  it('returns 404 for unknown or malformed ids', async () => {
    const missing = await request(app)
      .delete(`/api/admin/products/${new mongoose.Types.ObjectId()}/permanent`)
      .set(auth())
    assert.equal(missing.status, 404)
    const bad = await request(app).delete('/api/admin/products/not-an-id/permanent').set(auth())
    assert.equal(bad.status, 404)
  })

  it('requires an admin token', async () => {
    const product = await createProduct({ name: 'Seaweed' })
    const res = await request(app).delete(`/api/admin/products/${product._id}/permanent`)
    assert.equal(res.status, 401)
    assert.ok(await Product.exists({ _id: product._id }))
  })
})
