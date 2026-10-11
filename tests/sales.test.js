/**
 * Festival sales: admin management, storefront sale prices and the server-side checkout discount.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Sale, MAX_SALES } from '../src/models/Sale.js'
import { Order } from '../src/models/Order.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { quoteCart, createPaymentOrder } from '../src/services/checkoutService.js'
import { salePricePaise } from '../src/services/saleService.js'
import { buildOrderConfirmationEmail } from '../src/services/emailService.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import {
  checkoutInput,
  createAdmin,
  createProduct,
  standardFees,
  stubRazorpay,
} from './helpers/fixtures.js'

const HOUR = 60 * 60 * 1000

let app
let token
let seaweed
let kaamdev
let rzp

function admin(method, path) {
  return request(app)[method](`/api/admin${path}`).set('Authorization', `Bearer ${token}`)
}

async function addSale(body) {
  const res = await admin('post', '/sales').send(body)
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.data.sale
}

function quote(items, paymentMethod = 'PREPAID') {
  return quoteCart({
    items: items.map(([product, quantity = 1]) => ({ productId: String(product._id), quantity })),
    paymentMethod,
  })
}

async function publicProduct(product) {
  const res = await request(app).get(`/api/products/${product.slug}`)
  assert.equal(res.status, 200)
  return res.body.data.product
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
  seaweed = await createProduct({ name: 'Seaweed', pricePaise: 100000, fees: standardFees() })
  kaamdev = await createProduct({ name: 'Kaamdev', pricePaise: 49900, fees: standardFees() })
  rzp = stubRazorpay()
})

describe('sale price', () => {
  it('rounds to the nearest whole rupee', () => {
    assert.equal(salePricePaise(100000, 20), 80000)
    assert.equal(salePricePaise(49900, 20), 39900)
    assert.equal(salePricePaise(99900, 15), 84900)
  })
})

describe('admin sales', () => {
  it('requires an admin login for every route', async () => {
    const sale = await Sale.create({ name: 'Diwali Sale', percentOff: 20 })
    const calls = [
      request(app).get('/api/admin/sales'),
      request(app).post('/api/admin/sales').send({ name: 'Nope', percentOff: 10 }),
      request(app).patch(`/api/admin/sales/${sale._id}`).send({ active: false }),
      request(app).delete(`/api/admin/sales/${sale._id}`),
    ]
    for (const res of await Promise.all(calls)) {
      assert.equal(res.status, 401)
    }
    assert.equal(await Sale.countDocuments(), 1)
  })

  it('creates, lists with status, edits, toggles and deletes a sale', async () => {
    const sale = await addSale({ name: '  Diwali Sale  ', percentOff: 20 })
    assert.equal(sale.name, 'Diwali Sale')
    assert.equal(sale.appliesTo, 'ALL')
    assert.equal(sale.active, true)
    assert.equal(sale.status, 'LIVE')

    const edited = await admin('patch', `/sales/${sale.id}`).send({ percentOff: 25, name: 'Eid Sale' })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.data.sale.percentOff, 25)
    assert.equal(edited.body.data.sale.name, 'Eid Sale')

    const off = await admin('patch', `/sales/${sale.id}`).send({ active: false })
    assert.equal(off.body.data.sale.status, 'OFF')

    const list = await admin('get', '/sales')
    assert.equal(list.status, 200)
    assert.deepEqual(
      list.body.data.sales.map((s) => [s.name, s.status]),
      [['Eid Sale', 'OFF']],
    )

    assert.equal((await admin('delete', `/sales/${sale.id}`)).status, 200)
    assert.equal(await Sale.countDocuments(), 0)
    const again = await admin('delete', `/sales/${sale.id}`)
    assert.equal(again.status, 404)
    assert.equal(again.body.error.code, 'SALE_NOT_FOUND')
    assert.equal(await AuditLog.countDocuments({ action: 'SALE_CREATED' }), 1)
  })

  it('reports scheduled and ended sales from their dates', async () => {
    const now = Date.now()
    const scheduled = await addSale({
      name: 'Coming soon',
      percentOff: 10,
      startsAt: new Date(now + 24 * HOUR).toISOString(),
    })
    const ended = await addSale({
      name: 'Over',
      percentOff: 10,
      startsAt: new Date(now - 48 * HOUR).toISOString(),
      endsAt: new Date(now - 24 * HOUR).toISOString(),
    })
    assert.equal(scheduled.status, 'SCHEDULED')
    assert.equal(ended.status, 'ENDED')
  })

  it('validates input and rejects unknown fields', async () => {
    const cases = [
      {},
      { name: '', percentOff: 20 },
      { name: 'x'.repeat(61), percentOff: 20 },
      { name: 'Sale', percentOff: 0 },
      { name: 'Sale', percentOff: 91 },
      { name: 'Sale', percentOff: 12.5 },
      { name: 'Sale', percentOff: '20' },
      { name: 'Sale', percentOff: 20, appliesTo: 'SOME' },
      { name: 'Sale', percentOff: 20, startsAt: 'tomorrow' },
      { name: 'Sale', percentOff: 20, productIds: ['not-an-id'] },
      { name: 'Sale', percentOff: 20, extra: true },
    ]
    for (const body of cases) {
      const res = await admin('post', '/sales').send(body)
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.equal(res.body.error.code, 'VALIDATION_ERROR')
    }
    assert.equal(await Sale.countDocuments(), 0)
  })

  it('needs at least one existing product for a selected-products sale', async () => {
    const empty = await admin('post', '/sales').send({ name: 'Sale', percentOff: 20, appliesTo: 'PRODUCTS' })
    assert.equal(empty.status, 400)
    const missing = await admin('post', '/sales').send({
      name: 'Sale',
      percentOff: 20,
      appliesTo: 'PRODUCTS',
      productIds: ['64b000000000000000000009'],
    })
    assert.equal(missing.status, 400)
    assert.equal(await Sale.countDocuments(), 0)
  })

  it('rejects an end date that is not after the start date, on create and update', async () => {
    const start = new Date(Date.now() + 24 * HOUR)
    const res = await admin('post', '/sales').send({
      name: 'Sale',
      percentOff: 20,
      startsAt: start.toISOString(),
      endsAt: start.toISOString(),
    })
    assert.equal(res.status, 400)

    const sale = await addSale({ name: 'Sale', percentOff: 20, startsAt: start.toISOString() })
    const bad = await admin('patch', `/sales/${sale.id}`).send({
      endsAt: new Date(start.getTime() - HOUR).toISOString(),
    })
    assert.equal(bad.status, 400)
  })

  it(`caps the number of sales at ${MAX_SALES}`, async () => {
    await Sale.insertMany(
      Array.from({ length: MAX_SALES }, (_, i) => ({ name: `Sale ${i}`, percentOff: 10, active: false })),
    )
    const res = await admin('post', '/sales').send({ name: 'One too many', percentOff: 10 })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'SALE_LIMIT_REACHED')
  })
})

describe('storefront sale prices', () => {
  it('shows the sale price on every product for an all-products sale', async () => {
    await addSale({ name: 'Diwali Sale', percentOff: 20 })
    const res = await request(app).get('/api/products')
    assert.equal(res.status, 200)
    const bySlug = new Map(res.body.data.products.map((p) => [p.slug, p]))
    assert.deepEqual(bySlug.get(seaweed.slug).sale, {
      kind: 'SALE',
      name: 'Diwali Sale',
      percentOff: 20,
      pricePaise: 80000,
      price: 800,
      endsAt: null,
    })
    assert.equal(bySlug.get(kaamdev.slug).sale.pricePaise, 39900)
    assert.equal(bySlug.get(seaweed.slug).pricePaise, 100000)
  })

  it('only marks the selected products for a selected-products sale', async () => {
    await addSale({
      name: 'Eid Sale',
      percentOff: 15,
      appliesTo: 'PRODUCTS',
      productIds: [String(kaamdev._id)],
    })
    assert.equal((await publicProduct(seaweed)).sale, null)
    assert.equal((await publicProduct(kaamdev)).sale.name, 'Eid Sale')
  })

  it('ignores sales that are off, scheduled or ended', async () => {
    const now = Date.now()
    await addSale({ name: 'Off', percentOff: 30, active: false })
    await addSale({ name: 'Later', percentOff: 40, startsAt: new Date(now + HOUR).toISOString() })
    await addSale({
      name: 'Over',
      percentOff: 50,
      startsAt: new Date(now - 2 * HOUR).toISOString(),
      endsAt: new Date(now - HOUR).toISOString(),
    })
    assert.equal((await publicProduct(seaweed)).sale, null)
  })

  it('uses the highest live percentage when sales overlap', async () => {
    await addSale({ name: 'Diwali Sale', percentOff: 20 })
    await addSale({
      name: 'Seaweed Special',
      percentOff: 30,
      appliesTo: 'PRODUCTS',
      productIds: [String(seaweed._id)],
    })
    assert.equal((await publicProduct(seaweed)).sale.name, 'Seaweed Special')
    assert.equal((await publicProduct(seaweed)).sale.pricePaise, 70000)
    assert.equal((await publicProduct(kaamdev)).sale.name, 'Diwali Sale')
  })
})

describe('checkout discount', () => {
  it('takes the sale off the prepaid total and labels it with the sale name', async () => {
    await addSale({ name: 'Diwali Sale', percentOff: 20 })
    const q = await quote([[seaweed, 2]])
    assert.equal(q.pricing.subtotalPaise, 200000)
    assert.equal(q.pricing.discountPaise, 40000)
    assert.equal(q.pricing.discountLabel, 'Diwali Sale')
    assert.equal(q.pricing.totalPaise, 200000 - 40000 + 1000)
    assert.equal(q.items[0].unitPricePaise, 100000)
    assert.equal(q.items[0].discountPaise, 40000)
    assert.equal(q.items[0].totalPaise, 160000)
  })

  it('applies to COD totals too, with COD fees unchanged', async () => {
    await addSale({ name: 'Diwali Sale', percentOff: 20 })
    const q = await quote([[kaamdev]], 'COD')
    assert.equal(q.pricing.discountPaise, 10000)
    assert.equal(q.pricing.totalPaise, 49900 - 10000 + 9900 + 1000 + 8500)
  })

  it('discounts only the selected products', async () => {
    await addSale({
      name: 'Eid Sale',
      percentOff: 10,
      appliesTo: 'PRODUCTS',
      productIds: [String(seaweed._id)],
    })
    const q = await quote([[seaweed], [kaamdev]])
    assert.equal(q.pricing.subtotalPaise, 149900)
    assert.equal(q.pricing.discountPaise, 10000)
    assert.equal(q.items.find((i) => i.name === 'Kaamdev').discountPaise, 0)
  })

  it('uses a generic label when different sales cover the cart', async () => {
    await addSale({ name: 'Diwali Sale', percentOff: 10 })
    await addSale({
      name: 'Seaweed Special',
      percentOff: 30,
      appliesTo: 'PRODUCTS',
      productIds: [String(seaweed._id)],
    })
    const q = await quote([[seaweed], [kaamdev]])
    assert.equal(q.pricing.discountPaise, 30000 + 5000)
    assert.equal(q.pricing.discountLabel, 'Sale discount')
  })

  it('charges full price once a sale is switched off', async () => {
    const sale = await addSale({ name: 'Diwali Sale', percentOff: 20 })
    await admin('patch', `/sales/${sale.id}`).send({ active: false })
    const q = await quote([[seaweed]])
    assert.equal(q.pricing.discountPaise, 0)
    assert.equal(q.pricing.discountLabel, null)
    assert.equal(q.pricing.totalPaise, 101000)
  })

  it('creates the Razorpay order and stored order for the discounted total', async () => {
    await addSale({ name: 'Diwali Sale', percentOff: 20 })
    const res = await createPaymentOrder(checkoutInput({ productId: seaweed._id, paymentMethod: 'PREPAID' }))
    assert.equal(rzp.orderCalls[0].amount, 81000)
    const order = await Order.findOne({ orderNumber: res.orderNumber }).lean()
    assert.equal(order.pricing.discountPaise, 20000)
    assert.equal(order.pricing.discountLabel, 'Diwali Sale')
    assert.equal(order.pricing.totalPaise, 81000)
    assert.equal(order.items[0].discountPaise, 20000)

    const email = buildOrderConfirmationEmail(order)
    assert.match(email.html, /Diwali Sale/)
    assert.match(email.text, /Diwali Sale: −₹200/)
  })

  it('stores the sale on COD orders as well', async () => {
    await addSale({ name: 'Eid Sale', percentOff: 20 })
    const res = await createPaymentOrder(checkoutInput({ productId: kaamdev._id, paymentMethod: 'COD' }))
    const order = await Order.findOne({ orderNumber: res.orderNumber }).lean()
    assert.equal(order.pricing.discountPaise, 10000)
    assert.equal(order.pricing.totalPaise, 49900 - 10000 + 9900 + 1000 + 8500)
  })
})
