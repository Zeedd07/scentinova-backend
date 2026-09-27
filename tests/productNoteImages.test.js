/**
 * Product note images: backward compatibility, resolution, validation, and shared-asset safety.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MediaAsset } from '../src/models/MediaAsset.js'
import { Product } from '../src/models/Product.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import {
  createAdmin,
  createMediaAsset,
  createProduct,
  stubCloudinary,
} from './helpers/fixtures.js'

let app
let token
let cld

const auth = () => ({ Authorization: `Bearer ${token}` })

async function productWithNotes(notes, extra = {}) {
  const p = await createProduct({ name: 'Kaamdev' })
  Object.assign(p, { notes, ...extra })
  await p.save()
  return p
}

const getPublic = (slug) => request(app).get(`/api/products/${slug}`)

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
  cld = stubCloudinary()
})

afterEach(() => {
  cld.restore()
})

describe('public product note media', () => {
  it('keeps legacy string notes untouched and returns text-only noteMedia', async () => {
    // Simulates an existing production document with no new fields at all.
    const p = await createProduct({ name: 'Legacy' })
    await Product.collection.updateOne(
      { _id: p._id },
      {
        $set: { notes: { top: ['Bergamot'], heart: ['Rose'], base: ['Musk'] } },
        $unset: { noteImages: '', backgroundAssetId: '' },
      },
    )
    const res = await getPublic(p.slug)
    assert.equal(res.status, 200)
    const prod = res.body.data.product
    assert.deepEqual(prod.notes, { top: ['Bergamot'], heart: ['Rose'], base: ['Musk'] })
    assert.deepEqual(prod.noteMedia, {
      top: [{ name: 'Bergamot', image: null }],
      heart: [{ name: 'Rose', image: null }],
      base: [{ name: 'Musk', image: null }],
    })
  })

  it('resolves the global default and preserves TOP/HEART/BASE order', async () => {
    await createMediaAsset({ isDefault: true })
    const p = await productWithNotes({
      top: ['Bergamot'],
      heart: ['Amber', 'Jasmine Sambac'],
      base: ['Oud'],
    })
    const { noteMedia } = (await getPublic(p.slug)).body.data.product
    assert.deepEqual(noteMedia.heart.map((n) => n.name), ['Amber', 'Jasmine Sambac'])
    assert.equal(noteMedia.heart[0].image, null)
    const img = noteMedia.heart[1].image
    assert.equal(img.alt, 'Jasmine Sambac fragrance note')
    assert.match(img.url, /c_fill/)
    assert.match(img.url, /ar_1:1/)
    assert.match(img.url, /q_auto/)
    assert.match(img.url, /f_auto/)
    assert.equal(img.width, img.height)
    assert.match(img.srcSet, /640w/)
  })

  it('lets a product override win over the global default, and hideImage suppress it', async () => {
    await createMediaAsset({ isDefault: true, publicId: 'scentinova/notes/jasmine-sambac' })
    const custom = await createMediaAsset({ publicId: 'scentinova/notes/jasmine-sambac-2' })
    const a = await productWithNotes(
      { top: [], heart: ['Jasmine Sambac'], base: [] },
      { noteImages: [{ tier: 'HEART', noteKey: 'jasmine-sambac', assetId: custom._id, alt: 'Night jasmine' }] },
    )
    const imgA = (await getPublic(a.slug)).body.data.product.noteMedia.heart[0].image
    assert.match(imgA.url, /jasmine-sambac-2/)
    assert.equal(imgA.alt, 'Night jasmine')

    const b = await createProduct({ name: 'Other' })
    b.notes = { top: [], heart: ['Jasmine Sambac'], base: [] }
    b.noteImages = [{ tier: 'HEART', noteKey: 'jasmine-sambac', hideImage: true }]
    await b.save()
    const imgB = (await getPublic(b.slug)).body.data.product.noteMedia.heart[0].image
    assert.equal(imgB, null)
  })

  it('never exposes admin media references or public ids publicly', async () => {
    const bg = await createMediaAsset({ type: 'PRODUCT_BACKGROUND', name: 'Dusk' })
    const note = await createMediaAsset({ isDefault: true })
    const p = await productWithNotes(
      { top: [], heart: ['Jasmine Sambac'], base: [] },
      { backgroundAssetId: bg._id, noteImages: [{ tier: 'HEART', noteKey: 'jasmine-sambac', assetId: note._id }] },
    )
    const res = await getPublic(p.slug)
    const body = JSON.stringify(res.body)
    assert.equal(res.body.data.product.noteImages, undefined)
    assert.equal(res.body.data.product.backgroundAssetId, undefined)
    assert.ok(!body.includes('publicId'))
    assert.ok(!body.includes(String(bg._id)))

    const list = await request(app).get('/api/products')
    assert.equal(list.body.data.products[0].noteImages, undefined)
    assert.equal(list.body.data.products[0].backgroundAssetId, undefined)
  })

  it('keeps note search working on string notes', async () => {
    await productWithNotes({ top: [], heart: ['Jasmine Sambac'], base: [] })
    const res = await request(app).get('/api/products?search=jasmine')
    assert.equal(res.body.data.products.length, 1)
  })
})

describe('admin product media fields', () => {
  it('saves overrides and background, returning resolved admin media with a download URL', async () => {
    const note = await createMediaAsset()
    const bg = await createMediaAsset({ type: 'PRODUCT_BACKGROUND', name: 'Dusk' })
    const p = await productWithNotes({ top: [], heart: ['Jasmine Sambac'], base: [] })

    const res = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({
        noteImages: [{ tier: 'HEART', noteKey: 'Jasmine Sambac', assetId: String(note._id) }],
        backgroundAssetId: String(bg._id),
      })
    assert.equal(res.status, 200)
    const prod = res.body.data.product
    assert.deepEqual(prod.noteImages, [
      { tier: 'HEART', noteKey: 'jasmine-sambac', assetId: String(note._id), alt: null, hideImage: false },
    ])
    assert.equal(prod.media.noteAssets[String(note._id)].name, 'Jasmine Sambac')
    assert.match(prod.media.backgroundAsset.downloadUrl, /fl_attachment/)

    const get = await request(app).get(`/api/admin/products/${p._id}`).set(auth())
    assert.equal(get.body.data.product.media.backgroundAsset.id, String(bg._id))
  })

  it('rejects missing assets and assets of the wrong type', async () => {
    const p = await productWithNotes({ top: [], heart: ['Rose'], base: [] })
    const missing = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ noteImages: [{ tier: 'HEART', noteKey: 'rose', assetId: '000000000000000000000000' }] })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.code, 'INVALID_ASSET')

    const bg = await createMediaAsset({ type: 'PRODUCT_BACKGROUND', name: 'Dusk' })
    const wrongType = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ noteImages: [{ tier: 'HEART', noteKey: 'rose', assetId: String(bg._id) }] })
    assert.equal(wrongType.status, 400)

    const note = await createMediaAsset({ name: 'Rose' })
    const wrongBg = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ backgroundAssetId: String(note._id) })
    assert.equal(wrongBg.status, 400)
  })

  it('prunes overrides when a note is removed, without deleting the shared asset', async () => {
    const note = await createMediaAsset()
    const p = await productWithNotes(
      { top: [], heart: ['Jasmine Sambac', 'Rose'], base: [] },
      { noteImages: [{ tier: 'HEART', noteKey: 'jasmine-sambac', assetId: note._id }] },
    )
    const res = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ notes: { top: [], heart: ['Rose'], base: [] } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.product.noteImages, [])
    assert.ok(await MediaAsset.exists({ _id: note._id }))
    assert.equal(cld.state.destroys.length, 0)
  })

  it('creates a product with note images through the admin API', async () => {
    const note = await createMediaAsset({ name: 'Bergamot' })
    const res = await request(app)
      .post('/api/admin/products')
      .set(auth())
      .send({
        name: 'Citrus Test',
        price: 999,
        notes: { top: ['Bergamot'], heart: [], base: [] },
        noteImages: [{ tier: 'TOP', noteKey: 'bergamot', assetId: String(note._id) }],
      })
    assert.equal(res.status, 201)
    assert.equal(res.body.data.product.noteImages.length, 1)
    const pub = await getPublic(res.body.data.product.slug)
    assert.ok(pub.body.data.product.noteMedia.top[0].image)
  })

  it('archiving a product never deletes shared note or background assets', async () => {
    const note = await createMediaAsset({ isDefault: true })
    const bg = await createMediaAsset({ type: 'PRODUCT_BACKGROUND', name: 'Dusk' })
    const p = await productWithNotes(
      { top: [], heart: ['Jasmine Sambac'], base: [] },
      { backgroundAssetId: bg._id },
    )
    const res = await request(app).delete(`/api/admin/products/${p._id}`).set(auth())
    assert.equal(res.status, 200)
    assert.ok(await MediaAsset.exists({ _id: note._id }))
    assert.ok(await MediaAsset.exists({ _id: bg._id }))
    assert.equal(cld.state.destroys.length, 0)
  })
})
