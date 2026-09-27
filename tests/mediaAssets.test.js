/**
 * Admin media library — real Express app + in-memory MongoDB, Cloudinary network stubbed.
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
  TINY_PNG,
  createAdmin,
  createMediaAsset,
  createProduct,
  stubCloudinary,
} from './helpers/fixtures.js'

let app
let token
let cld

const auth = () => ({ Authorization: `Bearer ${token}` })

function uploadNote(fields = {}, file = { buffer: TINY_PNG, name: 'jasmine.png', type: 'image/png' }) {
  const req = request(app).post('/api/admin/media/upload').set(auth())
  for (const [k, v] of Object.entries({ type: 'NOTE', name: 'Jasmine Sambac', ...fields })) {
    req.field(k, v)
  }
  return req.attach('image', file.buffer, { filename: file.name, contentType: file.type })
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
  cld = stubCloudinary()
})

afterEach(() => {
  cld.restore()
})

describe('admin-only access', () => {
  it('rejects unauthenticated media and prompt requests', async () => {
    const list = await request(app).get('/api/admin/media')
    assert.equal(list.status, 401)
    const upload = await request(app)
      .post('/api/admin/media/upload')
      .field('type', 'NOTE')
      .field('name', 'Rose')
      .attach('image', TINY_PNG, { filename: 'rose.png', contentType: 'image/png' })
    assert.equal(upload.status, 401)
    assert.equal(cld.state.uploads.length, 0)
    const del = await request(app).delete('/api/admin/media/000000000000000000000000')
    assert.equal(del.status, 401)
    const prompt = await request(app).post('/api/admin/prompts/note').send({ noteName: 'Rose' })
    assert.equal(prompt.status, 401)
  })
})

describe('POST /api/admin/media/upload', () => {
  it('uploads a note to scentinova/notes with a normalized public id and default alt text', async () => {
    const res = await uploadNote({ tags: 'Jasmine, White Floral', category: 'FLORAL' })
    assert.equal(res.status, 201)
    const a = res.body.data.asset
    assert.equal(a.publicId, 'scentinova/notes/jasmine-sambac')
    assert.equal(a.folder, 'scentinova/notes')
    assert.equal(a.noteKey, 'jasmine-sambac')
    assert.equal(a.isDefault, true, 'first image for a note becomes the global default')
    assert.equal(a.altText, 'Jasmine Sambac fragrance note')
    assert.deepEqual(a.tags, ['jasmine', 'white-floral'])
    assert.equal(a.category, 'FLORAL')
    assert.match(a.thumbUrl, /c_fill/)
    assert.match(a.thumbUrl, /ar_1:1/)
    assert.match(a.downloadUrl, /fl_attachment/)
    assert.equal(cld.state.uploads[0].overwrite, false)
  })

  it('never overwrites: a second image with the same name gets a suffix and is not default', async () => {
    await uploadNote()
    const res = await uploadNote()
    assert.equal(res.status, 201)
    assert.equal(res.body.data.asset.publicId, 'scentinova/notes/jasmine-sambac-2')
    assert.equal(res.body.data.asset.isDefault, false)
  })

  it('skips a public id that already exists on Cloudinary but not in the library', async () => {
    cld.state.existing.add('scentinova/notes/rose')
    const res = await uploadNote({ name: 'Rose' })
    assert.equal(res.status, 201)
    assert.equal(res.body.data.asset.publicId, 'scentinova/notes/rose-2')
  })

  it('stores product backgrounds under scentinova/product-backgrounds', async () => {
    const res = await uploadNote({ type: 'PRODUCT_BACKGROUND', name: 'Lunar Leather' })
    assert.equal(res.status, 201)
    assert.equal(res.body.data.asset.publicId, 'scentinova/product-backgrounds/lunar-leather')
    assert.equal(res.body.data.asset.noteKey, null)
    assert.equal(res.body.data.asset.isDefault, false)
  })

  it('rejects unsupported file types and missing names without uploading', async () => {
    const bad = await uploadNote({}, { buffer: Buffer.from('hello'), name: 'x.txt', type: 'text/plain' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'INVALID_FILE')

    const noName = await uploadNote({ name: '' })
    assert.equal(noName.status, 400)
    assert.equal(noName.body.error.code, 'VALIDATION_ERROR')
    assert.equal(cld.state.uploads.length, 0)
  })

  it('does not leak stack traces on validation errors', async () => {
    const res = await uploadNote({ type: 'BOGUS' })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.stack, undefined)
  })
})

describe('GET /api/admin/media', () => {
  it('paginates 24 per page and filters by search and type', async () => {
    for (let i = 0; i < 26; i++) await createMediaAsset({ name: `Note ${i}` })
    await createMediaAsset({ name: 'Oud Smoke', tags: ['oud', 'woody'] })
    await createMediaAsset({ name: 'Dusk Set', type: 'PRODUCT_BACKGROUND' })

    const page1 = await request(app).get('/api/admin/media').set(auth())
    assert.equal(page1.status, 200)
    assert.equal(page1.body.data.assets.length, 24)
    assert.equal(page1.body.meta.total, 28)
    assert.equal(page1.body.meta.pages, 2)

    const search = await request(app).get('/api/admin/media?search=woody').set(auth())
    assert.deepEqual(search.body.data.assets.map((a) => a.name), ['Oud Smoke'])

    const bg = await request(app).get('/api/admin/media?type=PRODUCT_BACKGROUND').set(auth())
    assert.deepEqual(bg.body.data.assets.map((a) => a.name), ['Dusk Set'])

    const regexy = await request(app).get('/api/admin/media?search=(').set(auth())
    assert.equal(regexy.status, 200)
  })
})

describe('GET /api/admin/media/note-defaults', () => {
  it('returns global defaults keyed by normalized note name', async () => {
    await createMediaAsset({ isDefault: true })
    await createMediaAsset({ name: 'Rose' })
    const res = await request(app)
      .get('/api/admin/media/note-defaults?keys=Jasmine Sambac,Rose,Oud')
      .set(auth())
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.body.data.defaults), ['jasmine-sambac'])
  })
})

describe('PATCH /api/admin/media/:id', () => {
  it('moves the global default to another asset for the same note', async () => {
    const first = await createMediaAsset({ isDefault: true })
    const second = await createMediaAsset()
    const res = await request(app)
      .patch(`/api/admin/media/${second._id}`)
      .set(auth())
      .send({ isDefault: true, altText: 'Hand-picked jasmine' })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.asset.isDefault, true)
    assert.equal(res.body.data.asset.altText, 'Hand-picked jasmine')
    assert.equal((await MediaAsset.findById(first._id)).isDefault, false)
  })
})

describe('DELETE /api/admin/media/:id', () => {
  it('blocks deletion when a product references the asset as an override', async () => {
    const asset = await createMediaAsset()
    const p = await createProduct()
    p.notes = { top: [], heart: ['Jasmine Sambac'], base: [] }
    p.noteImages = [{ tier: 'HEART', noteKey: 'jasmine-sambac', assetId: asset._id }]
    await p.save()

    const res = await request(app).delete(`/api/admin/media/${asset._id}`).set(auth())
    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'ASSET_IN_USE')
    assert.equal(
      res.body.error.message,
      'This image is currently used by 1 product and cannot be deleted until it is no longer in use.',
    )
    assert.ok(await MediaAsset.exists({ _id: asset._id }))
    assert.equal(cld.state.destroys.length, 0)
  })

  it('counts products that rely on the asset as a global default, including archived ones', async () => {
    const asset = await createMediaAsset({ isDefault: true })
    const a = await createProduct({ name: 'A' })
    a.notes = { top: [], heart: ['Jasmine Sambac'], base: [] }
    await a.save()
    const b = await createProduct({ name: 'B' })
    b.notes = { top: ['jasmine  sambac'], heart: [], base: [] }
    b.active = false
    await b.save()

    const detail = await request(app).get(`/api/admin/media/${asset._id}`).set(auth())
    assert.equal(detail.body.data.usage.count, 2)

    const res = await request(app).delete(`/api/admin/media/${asset._id}`).set(auth())
    assert.equal(res.status, 409)
    assert.match(res.body.error.message, /used by 2 products/)
  })

  it('ignores products that hide or override the default image', async () => {
    const asset = await createMediaAsset({ isDefault: true })
    const other = await createMediaAsset()
    const p = await createProduct()
    p.notes = { top: [], heart: ['Jasmine Sambac'], base: ['Jasmine Sambac'] }
    p.noteImages = [
      { tier: 'HEART', noteKey: 'jasmine-sambac', hideImage: true },
      { tier: 'BASE', noteKey: 'jasmine-sambac', assetId: other._id },
    ]
    await p.save()

    const res = await request(app).delete(`/api/admin/media/${asset._id}`).set(auth())
    assert.equal(res.status, 200)
    assert.deepEqual(cld.state.destroys, [asset.publicId])
    assert.equal(await MediaAsset.exists({ _id: asset._id }), null)
  })

  it('keeps the library record when Cloudinary deletion fails', async () => {
    const asset = await createMediaAsset()
    cld.state.failDestroy = true
    const res = await request(app).delete(`/api/admin/media/${asset._id}`).set(auth())
    assert.equal(res.status, 502)
    assert.equal(res.body.error.code, 'CLOUDINARY_DELETE_FAILED')
    assert.ok(await MediaAsset.exists({ _id: asset._id }))
  })

  it('returns 404 for unknown or malformed ids', async () => {
    const res = await request(app).delete('/api/admin/media/not-an-id').set(auth())
    assert.equal(res.status, 404)
    const res2 = await request(app).delete('/api/admin/media/000000000000000000000000').set(auth())
    assert.equal(res2.status, 404)
  })

  it('protects library assets from the product-image cleanup path', async () => {
    const asset = await createMediaAsset()
    const p = await createProduct()
    await Product.updateOne({ _id: p._id }, { imagePublicId: asset.publicId })
    const res = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ imagePublicId: null })
    assert.equal(res.status, 200)
    assert.equal(cld.state.destroys.length, 0)
  })
})
