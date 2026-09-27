/**
 * Pure unit tests for the single authoritative checkout calculation (per-product fees).
 * Run: npm test
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PAYMENT_METHODS,
  assertPaymentMethodAllowed,
  calculateCheckoutPricing,
  computePaymentOptions,
  normalizePaymentMethod,
  normalizeProductFees,
  requiresRazorpay,
} from '../src/utils/pricing.js'
import { standardFees } from './helpers/fixtures.js'

const SUBTOTAL_499 = 49900

function line(fees, name = 'Seaweed', productId = '64b000000000000000000001') {
  return { productId, name, fees }
}

function price(method, lines, extra = {}) {
  return calculateCheckoutPricing({
    subtotalPaise: SUBTOTAL_499,
    paymentMethod: method,
    lines,
    ...extra,
  })
}

describe('payment method validation', () => {
  it('normalizes PREPAID and COD', () => {
    assert.equal(normalizePaymentMethod('prepaid'), 'PREPAID')
    assert.equal(normalizePaymentMethod('COD'), 'COD')
  })

  it('rejects invalid methods', () => {
    assert.throws(() => normalizePaymentMethod('UPI'), /Payment method/)
  })

  it('PREPAID requires Razorpay; COD does not', () => {
    assert.equal(requiresRazorpay('PREPAID'), true)
    assert.equal(requiresRazorpay('COD'), false)
  })

  it('online payment is always allowed; COD is blocked by any product that disallows it', () => {
    const ok = line(standardFees(), 'Seaweed')
    const blocked = line(standardFees({ codAllowed: false }), 'Kaamdev')
    assert.equal(assertPaymentMethodAllowed([ok, blocked], 'PREPAID'), 'PREPAID')
    assert.equal(assertPaymentMethodAllowed([ok], 'COD'), 'COD')
    assert.throws(
      () => assertPaymentMethodAllowed([ok, blocked], 'COD'),
      (err) =>
        err.code === 'PAYMENT_METHOD_DISABLED' &&
        err.statusCode === 400 &&
        err.message === 'Kaamdev is not available for cash on delivery.' &&
        err.fields.blockedBy[0] === 'Kaamdev',
    )
  })
})

describe('normalizeProductFees', () => {
  it('treats legacy products without fees as "no fees, COD allowed"', () => {
    const f = normalizeProductFees(undefined)
    assert.equal(f.convenience.amountPaise, 0)
    assert.equal(f.cod.amountPaise, 0)
    assert.equal(f.shipping.amountPaise, 0)
    assert.equal(f.codAllowed, true)
  })

  it('never charges the amount of a disabled fee', () => {
    const f = normalizeProductFees(
      standardFees({ convenience: { enabled: false }, cod: { enabled: false } }),
    )
    assert.equal(f.convenience.amountPaise, 0)
    assert.equal(f.cod.amountPaise, 0)
    assert.equal(f.shipping.amountPaise, 9900)
  })
})

describe('calculateCheckoutPricing', () => {
  it('no fees on the product: total equals the subtotal', () => {
    const p = price('COD', [line(undefined)])
    assert.equal(p.shippingPaise, 0)
    assert.equal(p.convenienceFeePaise, 0)
    assert.equal(p.codFeePaise, 0)
    assert.equal(p.totalPaise, SUBTOTAL_499)
  })

  it('one product PREPAID ₹499: shipping ₹99 + convenience ₹10, no COD fee = ₹608', () => {
    const p = price('PREPAID', [line(standardFees())])
    assert.equal(p.shippingPaise, 9900)
    assert.equal(p.convenienceFeePaise, 1000)
    assert.equal(p.codFeePaise, 0)
    assert.equal(p.totalPaise, 60800)
    assert.equal(p.total, 608)
  })

  it('one product COD ₹499: adds ₹85 COD fee = ₹693', () => {
    const p = price('COD', [line(standardFees())])
    assert.equal(p.codFeePaise, 8500)
    assert.equal(p.totalPaise, 69300)
  })

  it('mixed cart: convenience and COD fees add per product line; shipping takes the highest', () => {
    const lines = [
      line(standardFees(), 'A', '64b000000000000000000001'),
      line(
        standardFees({
          convenience: { amountPaise: 2500 },
          cod: { amountPaise: 5000 },
          shipping: { amountPaise: 14900 },
        }),
        'B',
        '64b000000000000000000002',
      ),
      line(undefined, 'C', '64b000000000000000000003'),
    ]
    const p = calculateCheckoutPricing({ subtotalPaise: 150000, paymentMethod: 'COD', lines })
    assert.equal(p.convenienceFeePaise, 1000 + 2500)
    assert.equal(p.codFeePaise, 8500 + 5000)
    assert.equal(p.shippingPaise, 14900)
    assert.equal(p.totalPaise, 150000 + 3500 + 13500 + 14900)
  })

  it('quantity does not multiply fees (fees are per line, not per unit)', () => {
    const p = calculateCheckoutPricing({
      subtotalPaise: SUBTOTAL_499 * 5,
      paymentMethod: 'COD',
      lines: [line(standardFees())],
    })
    assert.equal(p.convenienceFeePaise, 1000)
    assert.equal(p.codFeePaise, 8500)
    assert.equal(p.shippingPaise, 9900)
  })

  it('shipping is free when no product charges shipping', () => {
    const p = price('PREPAID', [line(standardFees({ shipping: { enabled: false } }))])
    assert.equal(p.shippingPaise, 0)
  })

  it('never charges a COD fee on prepaid', () => {
    assert.equal(price('PREPAID', [line(standardFees({ cod: { amountPaise: 99999 } }))]).codFeePaise, 0)
  })

  it('applies convenience fee only to the payment methods selected on the product', () => {
    const codOnly = [line(standardFees({ convenience: { applyToPrepaid: false } }))]
    assert.equal(price('PREPAID', codOnly).convenienceFeePaise, 0)
    assert.equal(price('COD', codOnly).convenienceFeePaise, 1000)
    const prepaidOnly = [line(standardFees({ convenience: { applyToCod: false } }))]
    assert.equal(price('PREPAID', prepaidOnly).convenienceFeePaise, 1000)
    assert.equal(price('COD', prepaidOnly).convenienceFeePaise, 0)
  })

  it('formula: subtotal - discount + shipping + convenience + cod (+ tax placeholder)', () => {
    const p = price('COD', [line(standardFees())], { discountPaise: 5000, taxPaise: 0 })
    assert.equal(p.totalPaise, 49900 - 5000 + 9900 + 1000 + 8500)
    assert.equal(p.taxPaise, 0)
  })

  it('returns integer paise and a per-product fee snapshot', () => {
    const p = price('COD', [line(standardFees())])
    for (const k of ['subtotalPaise', 'shippingPaise', 'convenienceFeePaise', 'codFeePaise', 'totalPaise']) {
      assert.ok(Number.isInteger(p[k]), k)
    }
    assert.equal(p.configVersion, null)
    assert.equal(p.pricingSnapshot.feeModel, 'PER_PRODUCT')
    assert.deepEqual(p.pricingSnapshot.lines, [
      {
        productId: '64b000000000000000000001',
        convenienceFeePaise: 1000,
        codFeePaise: 8500,
        shippingFeePaise: 9900,
        codAllowed: true,
      },
    ])
  })

  it('refuses to price an empty cart', () => {
    assert.throws(
      () => calculateCheckoutPricing({ subtotalPaise: SUBTOTAL_499, paymentMethod: 'PREPAID' }),
      (err) => err.code === 'PRICING_ERROR',
    )
  })

  it('rejects non-integer or negative amounts', () => {
    const lines = [line(standardFees())]
    assert.throws(() => price('PREPAID', lines, { subtotalPaise: 499.5 }), (err) => err.code === 'PRICING_ERROR')
    assert.throws(() => price('PREPAID', lines, { subtotalPaise: -1 }), (err) => err.code === 'PRICING_ERROR')
    assert.throws(
      () => price('PREPAID', [line(standardFees({ shipping: { amountPaise: -100 } }))]),
      (err) => err.code === 'PRICING_ERROR',
    )
    assert.throws(
      () => price('PREPAID', lines, { discountPaise: SUBTOTAL_499 + 1 }),
      (err) => err.code === 'PRICING_ERROR',
    )
  })
})

describe('computePaymentOptions', () => {
  it('summarises per-method fee hints and COD blockers for the UI', () => {
    const opts = computePaymentOptions([
      line(standardFees(), 'A'),
      line(standardFees({ codAllowed: false, convenience: { applyToPrepaid: false } }), 'B'),
    ])
    assert.deepEqual(opts.prepaid, { enabled: true, convenienceFeePaise: 1000 })
    assert.equal(opts.cod.enabled, false)
    assert.deepEqual(opts.cod.blockedBy, ['B'])
    assert.equal(opts.cod.codFeePaise, 17000)
    assert.equal(opts.cod.convenienceFeePaise, 2000)
  })
})

describe('COD vs PREPAID checkout contract', () => {
  it('COD responses do not require Razorpay', () => {
    assert.equal(requiresRazorpay(PAYMENT_METHODS.COD), false)
  })

  it('admin mark COD paid is only valid for COD payment method', () => {
    const canMark = (order) =>
      (order.paymentMethod === 'COD' || order.payment?.provider === 'cod') &&
      String(order.payment?.status || '').toUpperCase() === 'PENDING'
    assert.equal(canMark({ paymentMethod: 'COD', payment: { status: 'PENDING' } }), true)
    assert.equal(canMark({ paymentMethod: 'PREPAID', payment: { status: 'PENDING' } }), false)
    assert.equal(canMark({ paymentMethod: 'PREPAID', payment: { status: 'CAPTURED' } }), false)
  })
})
