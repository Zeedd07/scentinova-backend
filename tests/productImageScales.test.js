/**
 * Per-image storefront display size (galleryScales): saved by admins, public on
 * the catalogue, validated to 50%-200%.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Product } from '../src/models/Product.js'
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

describe('product image sizes', () => {
  it('saves sizes on create and shows them on the public product', async () => {
    const res = await request(app)
      .post('/api/admin/products')
      .set(auth())
      .send({
        name: 'Oud Nocturne',
        price: 2499,
        stock: 10,
        gallery: ['/products/a.png', '/products/b.png'],
        galleryScales: [1.25, 0.8],
      })
    assert.equal(res.status, 201)
    assert.deepEqual(res.body.data.product.galleryScales, [1.25, 0.8])

    const pub = await request(app).get(`/api/products/${res.body.data.product.slug}`)
    assert.equal(pub.status, 200)
    const body = pub.body.data.product || pub.body.data
    assert.deepEqual(body.galleryScales, [1.25, 0.8])
  })

  it('updates sizes and leaves them alone on unrelated updates', async () => {
    const p = await createProduct({ name: 'Seaweed' })
    let res = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ galleryScales: [1.5] })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.product.galleryScales, [1.5])

    res = await request(app).patch(`/api/admin/products/${p._id}`).set(auth()).send({ tagline: 'Salt' })
    assert.equal(res.status, 200)
    const stored = await Product.findById(p._id).lean()
    assert.deepEqual(stored.galleryScales, [1.5])
  })

  it('defaults to no sizes for products saved without them', async () => {
    const p = await createProduct({ name: 'Plain' })
    const stored = await Product.findById(p._id).lean()
    assert.deepEqual(stored.galleryScales, [])
  })

  it('rejects sizes outside 50%-200% or non-numbers', async () => {
    const p = await createProduct({ name: 'Seaweed' })
    for (const galleryScales of [[0.4], [2.1], ['big'], [-1]]) {
      const res = await request(app)
        .patch(`/api/admin/products/${p._id}`)
        .set(auth())
        .send({ galleryScales })
      assert.equal(res.status, 400, JSON.stringify(galleryScales))
    }
    const stored = await Product.findById(p._id).lean()
    assert.deepEqual(stored.galleryScales, [])
  })
})
