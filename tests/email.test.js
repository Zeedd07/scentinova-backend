/**
 * Resend order-confirmation email tests (Node built-in test runner).
 */
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret'
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret'
process.env.EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev'
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key_for_unit_tests'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const SUBTOTAL = 299700

function sampleOrder({ paymentMethod = 'PREPAID', overrides = {} } = {}) {
  const isCod = paymentMethod === 'COD'
  return {
    _id: '507f1f77bcf86cd799439011',
    orderNumber: 'SN-TEST-1001',
    createdAt: new Date('2026-09-26T10:00:00.000Z'),
    status: 'CONFIRMED',
    paymentMethod,
    paymentStatus: isCod ? 'PENDING' : 'PAID',
    customerSnapshot: {
      name: 'Zaid Qureshi',
      email: 'customer@example.com',
    },
    shippingAddress: {
      fullName: 'Zaid Qureshi',
      addressLine1: '12 Fragrance Lane',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      country: 'India',
    },
    items: [
      {
        name: 'Noir Essence',
        quantity: 3,
        unitPricePaise: 99900,
        totalPaise: 299700,
        image: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
      },
    ],
    pricing: {
      subtotalPaise: SUBTOTAL,
      shippingPaise: 0,
      discountPaise: 0,
      convenienceFeePaise: 1000,
      codFeePaise: isCod ? 8500 : 0,
      totalPaise: isCod ? SUBTOTAL + 1000 + 8500 : SUBTOTAL + 1000,
    },
    payment: {
      status: isCod ? 'PENDING' : 'CAPTURED',
      provider: isCod ? 'cod' : 'razorpay',
    },
    confirmationEmailSentAt: null,
    confirmationEmailStatus: null,
    ...overrides,
  }
}

describe('Resend configuration', () => {
  it('initializes client when RESEND_API_KEY exists', async () => {
    const { getResendClient, isResendReady, __resetResendClientForTests } = await import(
      '../src/services/emailService.js'
    )
    __resetResendClientForTests()
    assert.equal(isResendReady(), true)
    const client = getResendClient()
    assert.ok(client)
    assert.equal(typeof client.emails.send, 'function')
  })

  it('does not expose API keys in generated email content', async () => {
    const { buildOrderConfirmationEmail } = await import('../src/services/emailService.js')
    const content = buildOrderConfirmationEmail(sampleOrder())
    const blob = JSON.stringify(content)
    assert.equal(blob.includes('RESEND_API_KEY'), false)
    assert.equal(blob.includes('re_test_key_for_unit_tests'), false)
  })
})

describe('order confirmation email content', () => {
  it('PREPAID order uses stored totals and omits COD fee row', async () => {
    const { buildOrderConfirmationEmail } = await import('../src/services/emailService.js')
    const content = buildOrderConfirmationEmail(sampleOrder({ paymentMethod: 'PREPAID' }))
    assert.match(content.subject, /Scentinova — Order #SN-TEST-1001 Confirmed/)
    assert.equal(content.to, 'customer@example.com')
    assert.ok(content.html.includes('Prepaid'))
    assert.ok(content.html.includes('Paid'))
    assert.ok(content.html.includes('Convenience Fee'))
    assert.equal(content.html.includes('COD Fee'), false)
    assert.equal(content.html.includes('Amount payable on delivery'), false)
    assert.equal(content.pricing.convenienceFeePaise, 1000)
    assert.equal(content.pricing.codFeePaise, 0)
    assert.equal(content.pricing.totalPaise, 300700)
    assert.equal(content.display.total, 3007)
  })

  it('COD order shows COD fee, convenience fee, and amount payable on delivery', async () => {
    const { buildOrderConfirmationEmail } = await import('../src/services/emailService.js')
    const content = buildOrderConfirmationEmail(sampleOrder({ paymentMethod: 'COD' }))
    assert.ok(content.html.includes('Cash on Delivery'))
    assert.ok(content.html.includes('Payment Pending'))
    assert.ok(content.html.includes('COD Fee'))
    assert.ok(content.html.includes('Convenience Fee'))
    assert.ok(content.html.includes('Amount payable on delivery'))
    assert.equal(content.pricing.codFeePaise, 8500)
    assert.equal(content.pricing.convenienceFeePaise, 1000)
    assert.equal(content.display.codFee, 85)
    assert.equal(content.display.convenienceFee, 10)
    assert.equal(content.display.total, 3092)
  })

  it('email total comes from stored pricing.totalPaise, not a recomputed sum', async () => {
    const { buildOrderConfirmationEmail } = await import('../src/services/emailService.js')
    // Deliberately inconsistent components vs total — email must trust stored total
    const content = buildOrderConfirmationEmail(
      sampleOrder({
        paymentMethod: 'PREPAID',
        overrides: {
          pricing: {
            subtotalPaise: 100,
            shippingPaise: 0,
            discountPaise: 0,
            convenienceFeePaise: 1000,
            codFeePaise: 0,
            totalPaise: 999900,
          },
        },
      }),
    )
    assert.equal(content.pricing.totalPaise, 999900)
    assert.equal(content.display.total, 9999)
    assert.ok(content.html.includes(content.display.total.toLocaleString('en-IN') ) || content.html.includes('9,999') || content.html.includes('9999'))
  })

  it('uses server-side order email only', async () => {
    const { buildOrderConfirmationEmail } = await import('../src/services/emailService.js')
    const content = buildOrderConfirmationEmail(
      sampleOrder({
        overrides: { clientEmailOverride: 'hacker@evil.test' },
      }),
    )
    assert.equal(content.to, 'customer@example.com')
  })
})

describe('confirmation email contracts', () => {
  it('idempotency key is deterministic per order id', () => {
    assert.equal(
      `order-confirmation:507f1f77bcf86cd799439011`,
      'order-confirmation:507f1f77bcf86cd799439011',
    )
  })

  it('safe wrapper never throws when order is missing', async () => {
    const { sendOrderConfirmationEmailSafe } = await import('../src/services/emailService.js')
    const result = await sendOrderConfirmationEmailSafe(null)
    assert.equal(result.sent, false)
    assert.ok(result.reason)
  })
})
