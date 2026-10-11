/**
 * A product's own discount (percentage off or fixed price): admin validation, storefront
 * sale price, and the checkout discount, including how it competes with festival sales.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { Product } from '../src/models/Product.js'
import { quoteCart, createPaymentOrder } from '../src/services/checkoutService.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import {
  checkoutInput,
  createAdmin,
  createProduct,
  standardFees,
  stubRazorpay,
} from './helpers/fixtures.js'

let app
let token
let seaweed
let kaamdev
let rzp

function admin(method, path) {
  return request(app)[method](`/api/admin${path}`).set('Authorization', `Bearer ${token}`)
}

async function setDiscount(product, discount, extra = {}) {
  return admin('patch', `/products/${product._id}`).send({ discount, ...extra })
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

describe('admin product discount', () => {
  it('saves a percentage discount and clears the unused price field', async () => {
    const res = await setDiscount(seaweed, { type: 'PERCENT', percentOff: 15, salePricePaise: 50000 })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const stored = await Product.findById(seaweed._id).lean()
    assert.deepEqual(stored.discount, { type: 'PERCENT', percentOff: 15, salePricePaise: null })
  })

  it('saves a fixed discounted price', async () => {
    const res = await setDiscount(seaweed, { type: 'PRICE', salePricePaise: 79900 })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const stored = await Product.findById(seaweed._id).lean()
    assert.deepEqual(stored.discount, { type: 'PRICE', percentOff: null, salePricePaise: 79900 })
  })

  it('accepts a discount when creating a product', async () => {
    const res = await admin('post', '/products').send({
      name: 'Oud Royale',
      price: 2000,
      discount: { type: 'PRICE', salePricePaise: 150000 },
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const stored = await Product.findOne({ name: 'Oud Royale' }).lean()
    assert.equal(stored.discount.salePricePaise, 150000)
  })

  it('rejects a discounted price that is not below the regular price', async () => {
    const res = await setDiscount(seaweed, { type: 'PRICE', salePricePaise: 100000 })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /lower than the regular price/)
  })

  it('rejects lowering the regular price to or below an existing discounted price', async () => {
    await setDiscount(seaweed, { type: 'PRICE', salePricePaise: 80000 })
    const res = await admin('patch', `/products/${seaweed._id}`).send({ price: 800 })
    assert.equal(res.status, 400)
    const stored = await Product.findById(seaweed._id).lean()
    assert.equal(stored.pricePaise, 100000)
  })

  it('rejects percentages outside 1-90, missing amounts and part-rupee prices', async () => {
    for (const discount of [
      { type: 'PERCENT', percentOff: 0 },
      { type: 'PERCENT', percentOff: 91 },
      { type: 'PERCENT', percentOff: 12.5 },
      { type: 'PERCENT' },
      { type: 'PRICE' },
      { type: 'PRICE', salePricePaise: 79950 },
      { type: 'PRICE', salePricePaise: 0 },
      { type: 'HALF_OFF', percentOff: 50 },
    ]) {
      const res = await setDiscount(seaweed, discount)
      assert.equal(res.status, 400, `${JSON.stringify(discount)} should be rejected`)
    }
    const stored = await Product.findById(seaweed._id).lean()
    assert.equal(stored.discount.type, 'NONE')
  })

  it('turns the discount off', async () => {
    await setDiscount(seaweed, { type: 'PERCENT', percentOff: 15 })
    const res = await setDiscount(seaweed, { type: 'NONE', percentOff: 15 })
    assert.equal(res.status, 200)
    assert.equal((await publicProduct(seaweed)).sale, null)
    assert.equal((await quote([[seaweed]])).pricing.discountPaise, 0)
  })
})

describe('storefront price', () => {
  it('shows a percentage discount as the sale price without exposing the config', async () => {
    await setDiscount(kaamdev, { type: 'PERCENT', percentOff: 20 })
    const product = await publicProduct(kaamdev)
    assert.equal(product.discount, undefined)
    assert.deepEqual(product.sale, {
      kind: 'PRODUCT',
      name: 'Special price',
      percentOff: 20,
      pricePaise: 39900,
      price: 399,
      endsAt: null,
    })
  })

  it('shows a fixed price with its rounded percentage', async () => {
    await setDiscount(seaweed, { type: 'PRICE', salePricePaise: 85000 })
    const product = await publicProduct(seaweed)
    assert.equal(product.sale.price, 850)
    assert.equal(product.sale.percentOff, 15)
    const list = await request(app).get('/api/products')
    const listed = list.body.data.products.find((p) => p.slug === seaweed.slug)
    assert.equal(listed.sale.price, 850)
  })

  it('uses the festival sale when it gives the lower price', async () => {
    await setDiscount(seaweed, { type: 'PERCENT', percentOff: 10 })
    await admin('post', '/sales').send({ name: 'Diwali Sale', percentOff: 25 })
    const product = await publicProduct(seaweed)
    assert.equal(product.sale.kind, 'SALE')
    assert.equal(product.sale.name, 'Diwali Sale')
    assert.equal(product.sale.price, 750)
  })

  it('uses the product discount when it gives the lower price', async () => {
    await setDiscount(seaweed, { type: 'PRICE', salePricePaise: 60000 })
    await admin('post', '/sales').send({ name: 'Diwali Sale', percentOff: 25 })
    const product = await publicProduct(seaweed)
    assert.equal(product.sale.name, 'Special price')
    assert.equal(product.sale.price, 600)
    assert.equal((await publicProduct(kaamdev)).sale.name, 'Diwali Sale')
  })
})

describe('checkout with a product discount', () => {
  it('takes the discount off the total and labels it', async () => {
    await setDiscount(seaweed, { type: 'PRICE', salePricePaise: 79900 })
    const q = await quote([[seaweed, 2]])
    assert.equal(q.pricing.subtotalPaise, 200000)
    assert.equal(q.pricing.discountPaise, 2 * 20100)
    assert.equal(q.pricing.discountLabel, 'Special price')
    assert.equal(q.pricing.totalPaise, 200000 - 40200 + 1000)
    assert.equal(q.items[0].unitPricePaise, 100000)
  })

  it('never stacks with a festival sale', async () => {
    await setDiscount(seaweed, { type: 'PERCENT', percentOff: 10 })
    await admin('post', '/sales').send({ name: 'Eid Sale', percentOff: 20 })
    const q = await quote([[seaweed]])
    assert.equal(q.pricing.discountPaise, 20000)
    assert.equal(q.pricing.discountLabel, 'Eid Sale')
  })

  it('labels a cart mixing a product discount and a festival sale generically', async () => {
    await setDiscount(seaweed, { type: 'PERCENT', percentOff: 40 })
    await admin('post', '/sales').send({ name: 'Eid Sale', percentOff: 20 })
    const q = await quote([[seaweed], [kaamdev]])
    assert.equal(q.pricing.discountPaise, 40000 + 10000)
    assert.equal(q.pricing.discountLabel, 'Sale discount')
  })

  it('charges the discounted amount on Razorpay and stores it on the order', async () => {
    await setDiscount(seaweed, { type: 'PERCENT', percentOff: 15 })
    const res = await createPaymentOrder(
      checkoutInput({ productId: seaweed._id, paymentMethod: 'PREPAID' }),
    )
    assert.equal(rzp.orderCalls[0].amount, 85000 + 1000)
    const order = await Order.findOne({ orderNumber: res.orderNumber }).lean()
    assert.equal(order.pricing.discountPaise, 15000)
    assert.equal(order.pricing.discountLabel, 'Special price')
    assert.equal(order.pricing.totalPaise, 86000)
  })
})
