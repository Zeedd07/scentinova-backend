/**
 * Product videos: admin-only upload to Cloudinary (resource_type video), saved on
 * the product, public on the catalogue, and removed from Cloudinary when dropped.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Product } from '../src/models/Product.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import { createAdmin, createProduct, stubCloudinary, TINY_PNG } from './helpers/fixtures.js'

let app
let token
let cld

const auth = () => ({ Authorization: `Bearer ${token}` })
const FAKE_MP4 = Buffer.alloc(2048, 7)

function video(publicId) {
  return {
    publicId,
    url: `https://res.cloudinary.com/demo-test/video/upload/${publicId}.mp4`,
    posterUrl: `https://res.cloudinary.com/demo-test/video/upload/${publicId}.jpg`,
    width: 1080,
    height: 1920,
    duration: 12.4,
  }
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

describe('POST /api/admin/uploads/video', () => {
  it('requires an admin', async () => {
    const res = await request(app)
      .post('/api/admin/uploads/video')
      .attach('video', FAKE_MP4, { filename: 'clip.mp4', contentType: 'video/mp4' })
    assert.equal(res.status, 401)
    assert.equal(cld.state.uploads.length, 0)
  })

  it('uploads to the product folder as a video with an mp4 web version', async () => {
    const res = await request(app)
      .post('/api/admin/uploads/video')
      .set(auth())
      .field('slug', 'Oud Nocturne')
      .attach('video', FAKE_MP4, { filename: 'clip.mp4', contentType: 'video/mp4' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const v = res.body.data.video
    assert.match(v.publicId, /^scentinova\/products\/oud-nocturne\/video-[a-z0-9]+$/)
    assert.match(v.url, /^https:\/\/res\.cloudinary\.com\/demo-test\/video\/upload\/.+\.mp4(\?|$)/)
    assert.match(v.posterUrl, /\/video\/upload\/.+\.jpg(\?|$)/)

    assert.equal(cld.state.uploads.length, 1)
    const opts = cld.state.uploads[0]
    assert.equal(opts.resource_type, 'video')
    assert.equal(opts.overwrite, false)
    assert.equal(opts.eager_async, true)
    assert.equal(opts.eager[0].format, 'mp4')
  })

  it('rejects images and other non-video files', async () => {
    const res = await request(app)
      .post('/api/admin/uploads/video')
      .set(auth())
      .attach('video', TINY_PNG, { filename: 'x.png', contentType: 'image/png' })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'INVALID_FILE')
    assert.equal(cld.state.uploads.length, 0)
  })

  it('asks for a file when none is sent', async () => {
    const res = await request(app).post('/api/admin/uploads/video').set(auth()).field('slug', 'x')
    assert.equal(res.status, 400)
    assert.equal(cld.state.uploads.length, 0)
  })
})

describe('product videos', () => {
  it('saves videos and shows them on the public product with rebuilt URLs', async () => {
    const id = 'scentinova/products/oud/video-abc'
    const res = await request(app)
      .post('/api/admin/products')
      .set(auth())
      .send({ name: 'Oud Nocturne', price: 2499, stock: 5, videos: [video(id)] })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.data.product.videos.length, 1)

    const pub = await request(app).get(`/api/products/${res.body.data.product.slug}`)
    assert.equal(pub.status, 200)
    const body = pub.body.data.product || pub.body.data
    assert.equal(body.videos.length, 1)
    assert.equal(body.videos[0].publicId, id)
    assert.match(body.videos[0].url, /^https:\/\/res\.cloudinary\.com\/demo-test\/video\/upload\/.*q_auto.*\.mp4(\?|$)/)
    assert.match(body.videos[0].posterUrl, /\.jpg(\?|$)/)
    assert.equal(body.videos[0].duration, 12.4)
  })

  it('deletes removed videos from Cloudinary as videos, keeping the rest', async () => {
    const keep = 'scentinova/products/oud/video-keep'
    const drop = 'scentinova/products/oud/video-drop'
    const p = await createProduct({ name: 'Oud', videos: [video(keep), video(drop)] })

    const res = await request(app)
      .patch(`/api/admin/products/${p._id}`)
      .set(auth())
      .send({ videos: [video(keep)] })
    assert.equal(res.status, 200)
    assert.deepEqual(cld.state.destroyCalls, [
      { publicId: drop, options: { resource_type: 'video', invalidate: true } },
    ])
    const stored = await Product.findById(p._id).lean()
    assert.deepEqual(stored.videos.map((v) => v.publicId), [keep])
  })

  it('leaves videos alone on unrelated updates', async () => {
    const id = 'scentinova/products/oud/video-abc'
    const p = await createProduct({ name: 'Oud', videos: [video(id)] })
    const res = await request(app).patch(`/api/admin/products/${p._id}`).set(auth()).send({ tagline: 'Smoky' })
    assert.equal(res.status, 200)
    assert.equal(cld.state.destroys.length, 0)
    const stored = await Product.findById(p._id).lean()
    assert.equal(stored.videos.length, 1)
  })

  it('does not delete a video another product still uses', async () => {
    const shared = 'scentinova/products/shared/video-1'
    const a = await createProduct({ name: 'A', videos: [video(shared)] })
    await createProduct({ name: 'B', videos: [video(shared)] })
    const res = await request(app).patch(`/api/admin/products/${a._id}`).set(auth()).send({ videos: [] })
    assert.equal(res.status, 200)
    assert.equal(cld.state.destroys.length, 0)
  })

  it('deletes videos when the product is permanently deleted', async () => {
    const id = 'scentinova/products/gone/video-1'
    const p = await createProduct({ name: 'Gone', videos: [video(id)] })
    const res = await request(app).delete(`/api/admin/products/${p._id}/permanent`).set(auth())
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(cld.state.destroys, [id])
  })

  it('rejects foreign ids, non-https URLs and more than 6 videos', async () => {
    const p = await createProduct({ name: 'Oud' })
    const bad = [
      [{ ...video('scentinova/products/a/v'), publicId: 'someone-else/video' }],
      [{ ...video('scentinova/products/a/v'), url: 'http://example.com/v.mp4' }],
      [{ ...video('scentinova/products/a/v'), url: 'javascript:alert(1)' }],
      Array.from({ length: 7 }, (_, i) => video(`scentinova/products/a/v${i}`)),
    ]
    for (const videos of bad) {
      const res = await request(app).patch(`/api/admin/products/${p._id}`).set(auth()).send({ videos })
      assert.equal(res.status, 400, JSON.stringify(videos).slice(0, 120))
    }
    const stored = await Product.findById(p._id).lean()
    assert.deepEqual(stored.videos, [])
  })
})
