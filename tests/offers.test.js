/**
 * Announcement bar offers: public read of active offers, admin-only management.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Offer, MAX_OFFERS } from '../src/models/Offer.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import { createAdmin } from './helpers/fixtures.js'

let app
let token

function admin(method, path) {
  return request(app)[method](`/api/admin${path}`).set('Authorization', `Bearer ${token}`)
}

async function addOffer(text, active) {
  const res = await admin('post', '/offers').send(active === undefined ? { text } : { text, active })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.data.offer
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

describe('GET /api/offers (public)', () => {
  it('returns an empty list when there are no offers', async () => {
    const res = await request(app).get('/api/offers')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.offers, [])
  })

  it('returns only active offers, in display order, with id and text only', async () => {
    const a = await addOffer('Free shipping on all prepaid orders')
    await addOffer('Hidden offer', false)
    const c = await addOffer('New: Kaamdev is here')

    const res = await request(app).get('/api/offers')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.offers, [
      { id: a.id, text: 'Free shipping on all prepaid orders' },
      { id: c.id, text: 'New: Kaamdev is here' },
    ])
  })
})

describe('admin offers', () => {
  it('requires an admin login for every route', async () => {
    const offer = await Offer.create({ text: 'Existing', sortOrder: 0 })
    const calls = [
      request(app).get('/api/admin/offers'),
      request(app).post('/api/admin/offers').send({ text: 'Nope' }),
      request(app).patch(`/api/admin/offers/${offer._id}`).send({ active: false }),
      request(app).delete(`/api/admin/offers/${offer._id}`),
      request(app).put('/api/admin/offers/order').send({ ids: [String(offer._id)] }),
    ]
    for (const res of await Promise.all(calls)) {
      assert.equal(res.status, 401)
    }
    assert.equal(await Offer.countDocuments(), 1)
    assert.equal((await Offer.findById(offer._id)).active, true)
  })

  it('creates offers (trimmed, active by default) and lists hidden ones too', async () => {
    const first = await addOffer('  Free shipping on all prepaid orders  ')
    assert.equal(first.text, 'Free shipping on all prepaid orders')
    assert.equal(first.active, true)
    assert.equal(first.sortOrder, 0)
    const second = await addOffer('Hidden', false)
    assert.equal(second.sortOrder, 1)

    const res = await admin('get', '/offers')
    assert.equal(res.status, 200)
    assert.deepEqual(
      res.body.data.offers.map((o) => [o.text, o.active]),
      [
        ['Free shipping on all prepaid orders', true],
        ['Hidden', false],
      ],
    )
    assert.equal(await AuditLog.countDocuments({ action: 'OFFER_CREATED' }), 2)
  })

  it('edits text and toggles visibility', async () => {
    const offer = await addOffer('Old text')
    const edited = await admin('patch', `/offers/${offer.id}`).send({ text: 'New text' })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.data.offer.text, 'New text')

    const hidden = await admin('patch', `/offers/${offer.id}`).send({ active: false })
    assert.equal(hidden.status, 200)
    assert.equal(hidden.body.data.offer.active, false)
    assert.deepEqual((await request(app).get('/api/offers')).body.data.offers, [])
  })

  it('reorders offers with one call', async () => {
    const a = await addOffer('A')
    const b = await addOffer('B')
    const c = await addOffer('C')
    const res = await admin('put', '/offers/order').send({ ids: [c.id, a.id, b.id] })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.offers.map((o) => o.text), ['C', 'A', 'B'])
    const pub = await request(app).get('/api/offers')
    assert.deepEqual(pub.body.data.offers.map((o) => o.text), ['C', 'A', 'B'])
  })

  it('rejects a reorder that does not list every offer exactly once', async () => {
    const a = await addOffer('A')
    const b = await addOffer('B')
    for (const ids of [[a.id], [a.id, a.id], [a.id, b.id, '64b000000000000000000009']]) {
      const res = await admin('put', '/offers/order').send({ ids })
      assert.equal(res.status, 400, JSON.stringify(ids))
    }
    const pub = await request(app).get('/api/offers')
    assert.deepEqual(pub.body.data.offers.map((o) => o.text), ['A', 'B'])
  })

  it('deletes an offer', async () => {
    const offer = await addOffer('Going away')
    const res = await admin('delete', `/offers/${offer.id}`)
    assert.equal(res.status, 200)
    assert.equal(await Offer.countDocuments(), 0)
    const again = await admin('delete', `/offers/${offer.id}`)
    assert.equal(again.status, 404)
    assert.equal(again.body.error.code, 'OFFER_NOT_FOUND')
  })

  it('returns 404 for unknown or malformed ids', async () => {
    assert.equal((await admin('patch', '/offers/not-an-id').send({ active: false })).status, 404)
    assert.equal(
      (await admin('patch', '/offers/64b000000000000000000009').send({ active: false })).status,
      404,
    )
  })

  it('validates text length and rejects unknown fields', async () => {
    const cases = [
      {},
      { text: '' },
      { text: '   ' },
      { text: 'x'.repeat(121) },
      { text: 'Fine', sortOrder: 5 },
      { text: 'Fine', active: 'yes' },
    ]
    for (const body of cases) {
      const res = await admin('post', '/offers').send(body)
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.equal(res.body.error.code, 'VALIDATION_ERROR')
    }
    const offer = await addOffer('x'.repeat(120))
    assert.equal((await admin('patch', `/offers/${offer.id}`).send({})).status, 400)
    assert.equal(
      (await admin('patch', `/offers/${offer.id}`).send({ text: 'ok', sortOrder: 1 })).status,
      400,
    )
    assert.equal(await Offer.countDocuments(), 1)
  })

  it(`caps the number of offers at ${MAX_OFFERS}`, async () => {
    for (let i = 0; i < MAX_OFFERS; i += 1) await addOffer(`Offer ${i}`)
    const res = await admin('post', '/offers').send({ text: 'One too many' })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'OFFER_LIMIT_REACHED')
    assert.equal(await Offer.countDocuments(), MAX_OFFERS)
  })
})
