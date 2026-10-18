/**
 * A perfume can be sold in several bottle sizes, each with its own price.
 * Checkout charges the size the shopper picked. Older products keep one size.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { Order } from '../src/models/Order.js'
import { Product } from '../src/models/Product.js'
import { createPaymentOrder, quoteCart } from '../src/services/checkoutService.js'
import { createSale } from '../src/services/saleService.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import { checkoutInput, createAdmin, createProduct, standardFees, stubRazorpay } from './helpers/fixtures.js'

let app
let token
let product

const SIZES = [
  { ml: 50, price: 2499 },
  { ml: 20, price: 1499 },
  { ml: 10, price: 799 },
]

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
  stubRazorpay()
  const created = await admin('post', '/products').send({
    name: 'Seaweed',
    price: 2499,
    sizes: SIZES,
    stock: 20,
    fees: standardFees(),
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  product = created.body.data.product
})

describe('product sizes', () => {
  it('saves each size and keeps the product price in sync with the first', async () => {
    assert.equal(product.price, 2499)
    assert.equal(product.pricePaise, 249900)
    assert.equal(product.size, '50ml')
    assert.deepEqual(
      product.sizes.map((s) => ({ ml: s.ml, price: s.price })),
      SIZES,
    )

    const pub = await request(app).get(`/api/products/${product.slug}`)
    assert.equal(pub.status, 200)
    assert.deepEqual(
      pub.body.data.product.sizes.map((s) => ({ ml: s.ml, label: s.label, price: s.price, sale: s.sale })),
      [
        { ml: 50, label: '50ml', price: 2499, sale: null },
        { ml: 20, label: '20ml', price: 1499, sale: null },
        { ml: 10, label: '10ml', price: 799, sale: null },
      ],
    )
  })

  it('keeps optional photos and videos on a size and leaves the others on the main bottle', async () => {
    const clip = {
      publicId: 'scentinova/products/seaweed/clip',
      url: 'https://res.cloudinary.com/demo/video/upload/scentinova/products/seaweed/clip.mp4',
      posterUrl: 'https://res.cloudinary.com/demo/video/upload/scentinova/products/seaweed/clip.jpg',
      width: 720,
      height: 1280,
      duration: 4,
    }
    const photos = [
      'https://res.cloudinary.com/demo/image/upload/scentinova/products/seaweed-20-a.jpg',
      'https://res.cloudinary.com/demo/image/upload/scentinova/products/seaweed-20-b.jpg',
    ]
    const saved = await admin('patch', `/products/${product.id}`).send({
      gallery: ['https://res.cloudinary.com/demo/image/upload/scentinova/products/seaweed-50.jpg'],
      sizes: [
        {
          ml: 50,
          price: 2499,
          gallery: ['https://res.cloudinary.com/demo/image/upload/scentinova/products/ignored.jpg'],
          videos: [clip],
        },
        {
          ml: 20,
          price: 1499,
          gallery: photos,
          galleryPublicIds: ['scentinova/products/seaweed-20-a', 'scentinova/products/seaweed-20-b'],
          galleryScales: [1, 1.2],
          videos: [clip],
        },
        { ml: 10, price: 799 },
      ],
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const adminSizes = saved.body.data.product.sizes
    assert.equal(adminSizes[0].gallery, undefined)
    assert.equal(adminSizes[0].videos, undefined)
    assert.deepEqual(adminSizes[1].gallery, photos)
    assert.equal(adminSizes[1].videos.length, 1)
    assert.equal(adminSizes[2].gallery, undefined)
    assert.equal(adminSizes[2].videos, undefined)

    const pub = await request(app).get(`/api/products/${product.slug}`)
    assert.equal(pub.status, 200)
    const body = pub.body.data.product
    assert.deepEqual(body.gallery, [
      'https://res.cloudinary.com/demo/image/upload/scentinova/products/seaweed-50.jpg',
    ])
    const byMl = Object.fromEntries(body.sizes.map((s) => [s.ml, s]))
    assert.equal(byMl[50].gallery, undefined)
    assert.equal(byMl[50].videos, undefined)
    assert.deepEqual(byMl[20].gallery, photos)
    assert.deepEqual(byMl[20].galleryScales, [1, 1.2])
    assert.equal(byMl[20].videos[0].publicId, clip.publicId)
    assert.equal(byMl[10].gallery, undefined)
    assert.equal(byMl[10].videos, undefined)
  })

  it('rejects a duplicate size and a price below ₹1', async () => {
    const duplicate = await admin('patch', `/products/${product.id}`).send({
      sizes: [
        { ml: 50, price: 2499 },
        { ml: 50, price: 999 },
      ],
    })
    assert.equal(duplicate.status, 400)
    assert.match(duplicate.body.error.fields['sizes.1.ml'], /already/)

    const cheap = await admin('patch', `/products/${product.id}`).send({
      sizes: [{ ml: 10, price: 0 }],
    })
    assert.equal(cheap.status, 400)
    assert.equal(await Product.countDocuments({ 'sizes.price': 0 }), 0)
  })

  it('charges the size the shopper picked', async () => {
    const quote = await quoteCart({
      items: [{ productId: product.id, quantity: 2, sizeMl: 10, unitPricePaise: 79900 }],
    })
    assert.equal(quote.items[0].size, '10ml')
    assert.equal(quote.items[0].unitPricePaise, 79900)
    assert.equal(quote.pricing.subtotalPaise, 159800)

    const created = await createPaymentOrder(
      checkoutInput({
        productId: product.id,
        quantity: 2,
        paymentMethod: 'COD',
        extra: { items: [{ productId: product.id, quantity: 2, sizeMl: 20 }] },
      }),
    )
    const order = await Order.findOne({ orderNumber: created.orderNumber }).lean()
    assert.equal(order.items[0].size, '20ml')
    assert.equal(order.items[0].unitPricePaise, 149900)
  })

  it('rejects a size the perfume is not sold in', async () => {
    await assert.rejects(
      quoteCart({ items: [{ productId: product.id, quantity: 1, sizeMl: 15 }] }),
      (err) => err.statusCode === 400 && err.code === 'INVALID_SIZE',
    )
    assert.equal(await Order.countDocuments(), 0)
  })

  it('applies a percent sale to the chosen size, and a fixed price only to the first', async () => {
    await createSale({ name: 'Diwali Sale', percentOff: 10, appliesTo: 'ALL', active: true }, {})
    const quote = await quoteCart({
      items: [{ productId: product.id, quantity: 1, sizeMl: 20 }],
    })
    assert.equal(quote.items[0].unitPricePaise, 149900)
    assert.equal(quote.items[0].discountPaise, 149900 - 134900)
    assert.equal(quote.pricing.discountLabel, 'Diwali Sale')

    await Product.updateOne({ _id: product.id }, { $set: { 'discount.type': 'PRICE', 'discount.salePricePaise': 199900, 'discount.percentOff': null } })
    const { Sale } = await import('../src/models/Sale.js')
    await Sale.deleteMany({})
    const fixed = await quoteCart({
      items: [
        { productId: product.id, quantity: 1, sizeMl: 50 },
        { productId: product.id, quantity: 1, sizeMl: 10 },
      ],
    })
    const bySize = Object.fromEntries(fixed.items.map((i) => [i.size, i]))
    assert.equal(bySize['50ml'].unitPricePaise, 249900)
    assert.equal(bySize['50ml'].totalPaise, 199900)
    assert.equal(bySize['10ml'].unitPricePaise, 79900)
    assert.equal(bySize['10ml'].discountPaise, 0)
  })

  it('still checks out an older product that has only one size and price', async () => {
    const legacy = await createProduct({ name: 'Aurum', pricePaise: 189900, stock: 5, fees: standardFees() })
    const quote = await quoteCart({
      items: [{ productId: String(legacy._id), quantity: 1 }],
    })
    assert.equal(quote.items[0].size, '50ml')
    assert.equal(quote.items[0].unitPricePaise, 189900)
  })
})
