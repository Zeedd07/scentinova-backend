import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { Admin } from '../../src/models/Admin.js'
import { Product } from '../../src/models/Product.js'
import { MediaAsset } from '../../src/models/MediaAsset.js'
import { env } from '../../src/config/env.js'
import { getCloudinary } from '../../src/config/cloudinary.js'
import { PricingSettings, PRICING_SETTINGS_KEY } from '../../src/models/PricingSettings.js'
import { signAccessToken } from '../../src/utils/jwt.js'
import { getRazorpay } from '../../src/config/razorpay.js'

/** Per-product fees matching the old live global values (₹99 shipping / ₹10 convenience / ₹85 COD). */
export function standardFees(overrides = {}) {
  const base = {
    convenience: { enabled: true, amountPaise: 1000, applyToPrepaid: true, applyToCod: true },
    cod: { enabled: true, amountPaise: 8500 },
    shipping: { enabled: true, amountPaise: 9900 },
    codAllowed: true,
  }
  for (const [section, values] of Object.entries(overrides)) {
    base[section] =
      values && typeof values === 'object' ? { ...base[section], ...values } : values
  }
  return base
}

/** Legacy global settings document (kept in the DB after the move to per-product fees). */
export async function seedLegacySettings() {
  return PricingSettings.create({
    key: PRICING_SETTINGS_KEY,
    shipping: {
      enabled: true,
      standardFeePaise: 9900,
      freeShippingEnabled: true,
      freeShippingThresholdPaise: 250000,
    },
    convenienceFee: { enabled: true, amountPaise: 1000, applyToPrepaid: true, applyToCod: true },
    codFee: { enabled: true, amountPaise: 8500 },
    paymentMethods: { prepaidEnabled: true, codEnabled: true },
    version: 1,
  })
}

export async function createAdmin({ email = 'admin@test.local' } = {}) {
  const admin = await Admin.create({
    name: 'Test Admin',
    email,
    passwordHash: 'not-a-real-hash',
    role: 'admin',
    active: true,
  })
  const token = signAccessToken({ sub: admin._id.toString(), role: 'admin' })
  return { admin, token }
}

export async function createProduct({
  name = 'Seaweed',
  pricePaise = 49900,
  stock = 100,
  fees,
} = {}) {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomUUID().slice(0, 6)}`
  return Product.create({
    name,
    slug,
    sku: slug.toUpperCase(),
    pricePaise,
    price: pricePaise / 100,
    stock,
    active: true,
    ...(fees ? { fees } : {}),
  })
}

export function checkoutInput({ productId, quantity = 1, paymentMethod = 'PREPAID', extra = {} }) {
  return {
    paymentMethod,
    customer: { name: 'Test Buyer', email: 'buyer@example.com', phone: '9999999999' },
    shippingAddress: {
      fullName: 'Test Buyer',
      phone: '9999999999',
      addressLine1: '1 Test Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      country: 'India',
    },
    items: [{ productId: String(productId), quantity }],
    ...extra,
  }
}

/**
 * Replace network calls on the cached Razorpay SDK client.
 * @returns {{ orderCalls: any[], setPaymentAmount: (paise:number) => void }}
 */
export function stubRazorpay() {
  const rzp = getRazorpay()
  const orderCalls = []
  let paymentAmount = null
  rzp.orders.create = async (params) => {
    orderCalls.push(params)
    return {
      id: `order_test_${orderCalls.length}_${crypto.randomUUID().slice(0, 8)}`,
      amount: params.amount,
      currency: params.currency,
    }
  }
  rzp.payments.fetch = async (id) => ({
    id,
    amount: paymentAmount,
    status: 'captured',
    method: 'upi',
  })
  return {
    orderCalls,
    setPaymentAmount(paise) {
      paymentAmount = paise
    },
  }
}

/**
 * Enable Cloudinary with dummy credentials and replace network calls.
 * URL building stays real (offline); uploads/destroys are recorded.
 */
export function stubCloudinary() {
  const saved = { ...env.cloudinary }
  env.cloudinary.cloudName = 'demo-test'
  env.cloudinary.apiKey = 'test-key'
  env.cloudinary.apiSecret = 'test-cloudinary-secret'
  const cld = getCloudinary()
  const original = {
    upload_stream: cld.uploader.upload_stream,
    destroy: cld.uploader.destroy,
  }
  const state = { uploads: [], destroys: [], failDestroy: false, existing: new Set() }

  cld.uploader.upload_stream = (options, cb) => {
    const sink = new PassThrough()
    sink.resume()
    sink.on('end', () => {
      const publicId = options.public_id
      const existing = state.existing.has(publicId)
      state.uploads.push(options)
      state.existing.add(publicId)
      cb(null, {
        public_id: publicId,
        secure_url: `https://res.cloudinary.com/demo-test/image/upload/v1/${publicId}.jpg`,
        width: 800,
        height: 800,
        format: 'jpg',
        bytes: 1234,
        ...(existing ? { existing: true } : {}),
      })
    })
    return sink
  }
  cld.uploader.destroy = async (publicId) => {
    state.destroys.push(publicId)
    if (state.failDestroy) throw new Error('network down')
    return { result: 'ok' }
  }

  return {
    state,
    restore() {
      cld.uploader.upload_stream = original.upload_stream
      cld.uploader.destroy = original.destroy
      Object.assign(env.cloudinary, saved)
    },
  }
}

export async function createMediaAsset(overrides = {}) {
  const name = overrides.name || 'Jasmine Sambac'
  const type = overrides.type || 'NOTE'
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const folder = type === 'NOTE' ? 'scentinova/notes' : 'scentinova/product-backgrounds'
  const publicId = overrides.publicId || `${folder}/${key}-${crypto.randomUUID().slice(0, 6)}`
  return MediaAsset.create({
    type,
    name,
    noteKey: type === 'NOTE' ? key : null,
    isDefault: false,
    category: 'OTHER',
    publicId,
    folder,
    url: `https://res.cloudinary.com/demo-test/image/upload/v1/${publicId}.jpg`,
    altText: `${name} fragrance note`,
    ...overrides,
  })
}

/** Smallest valid PNG (1x1). */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

export function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex')
}
