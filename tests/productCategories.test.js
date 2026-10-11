/**
 * Admin-defined product categories: listing those in use and saving new ones.
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

function admin(method, path) {
  return request(app)[method](`/api/admin${path}`).set('Authorization', `Bearer ${token}`)
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

describe('product categories', () => {
  it('requires an admin', async () => {
    const res = await request(app).get('/api/admin/products/categories')
    assert.equal(res.status, 401)
  })

  it('lists categories in use once each, sorted, ignoring blanks and case', async () => {
    const a = await createProduct({ name: 'Seaweed' })
    const b = await createProduct({ name: 'Kaamdev' })
    const c = await createProduct({ name: 'Mitti' })
    const d = await createProduct({ name: 'Plain' })
    await Product.updateOne({ _id: a._id }, { category: 'Woody' })
    await Product.updateOne({ _id: b._id }, { category: 'Aquatic' })
    await Product.updateOne({ _id: c._id }, { category: 'woody' })
    await Product.updateOne({ _id: d._id }, { category: '' })

    const res = await admin('get', '/products/categories')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.categories, ['Aquatic', 'Woody'])
  })

  it('saves a brand-new category, trimmed, and lists it afterwards', async () => {
    const product = await createProduct({ name: 'Seaweed' })
    const res = await admin('patch', `/products/${product._id}`).send({ category: '  Aquatic  ' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.product.category, 'Aquatic')

    const list = await admin('get', '/products/categories')
    assert.deepEqual(list.body.data.categories, ['Aquatic'])
  })

  it('rejects category names longer than 40 characters', async () => {
    const product = await createProduct({ name: 'Seaweed' })
    const res = await admin('patch', `/products/${product._id}`).send({ category: 'x'.repeat(41) })
    assert.equal(res.status, 400)
  })
})
