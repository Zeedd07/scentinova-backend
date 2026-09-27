/**
 * Authoritative checkout pricing — pure integers (paise).
 * The ONLY place checkout totals are computed. Inputs: trusted DB subtotal + fee
 * configuration read from the Product documents in the cart. Never accept fees or
 * totals from clients.
 *
 * Fee rules:
 *   - convenience / COD fee: charged once per cart line (quantity does not multiply)
 *   - shipping: one parcel per order, so the highest line shipping fee is charged
 *   - COD is available only when every line allows it
 */
import { ApiError } from './ApiError.js'
import { paiseToRupees } from './money.js'

export const PAYMENT_METHODS = Object.freeze({
  PREPAID: 'PREPAID',
  COD: 'COD',
})

export const FEE_MODEL = 'PER_PRODUCT'

export function normalizePaymentMethod(value) {
  const method = String(value || PAYMENT_METHODS.PREPAID)
    .trim()
    .toUpperCase()
  if (method !== PAYMENT_METHODS.PREPAID && method !== PAYMENT_METHODS.COD) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Payment method must be PREPAID or COD.')
  }
  return method
}

export function requiresRazorpay(paymentMethod) {
  return normalizePaymentMethod(paymentMethod) === PAYMENT_METHODS.PREPAID
}

function assertPaise(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(500, 'PRICING_ERROR', `Invalid ${label} amount.`)
  }
  return value
}

function plain(value) {
  return value && typeof value.toObject === 'function' ? value.toObject() : value
}

/**
 * Product fee config with legacy-safe defaults (no fees, COD allowed).
 * Amounts of disabled fees are resolved to 0 so they can never be charged.
 */
export function normalizeProductFees(rawFees) {
  const fees = plain(rawFees) || {}
  const convenience = plain(fees.convenience) || {}
  const cod = plain(fees.cod) || {}
  const shipping = plain(fees.shipping) || {}
  return {
    convenience: {
      enabled: convenience.enabled === true,
      amountPaise: convenience.enabled === true ? convenience.amountPaise ?? 0 : 0,
      applyToPrepaid: convenience.applyToPrepaid !== false,
      applyToCod: convenience.applyToCod !== false,
    },
    cod: {
      enabled: cod.enabled === true,
      amountPaise: cod.enabled === true ? cod.amountPaise ?? 0 : 0,
    },
    shipping: {
      enabled: shipping.enabled === true,
      amountPaise: shipping.enabled === true ? shipping.amountPaise ?? 0 : 0,
    },
    codAllowed: fees.codAllowed !== false,
  }
}

function lineConvenienceFee(fees, method) {
  const applies =
    method === PAYMENT_METHODS.COD ? fees.convenience.applyToCod : fees.convenience.applyToPrepaid
  return applies ? assertPaise(fees.convenience.amountPaise, 'convenience fee') : 0
}

function prepareLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ApiError(500, 'PRICING_ERROR', 'Cannot price an empty cart.')
  }
  return lines.map((line) => ({
    productId: line.productId != null ? String(line.productId) : null,
    name: line.name || '',
    fees: normalizeProductFees(line.fees),
  }))
}

/** Names of cart products that do not allow cash on delivery. */
export function codBlockedBy(lines) {
  return prepareLines(lines)
    .filter((l) => !l.fees.codAllowed)
    .map((l) => l.name)
}

/** Online payment is always available; COD only when every product allows it. */
export function assertPaymentMethodAllowed(lines, paymentMethod) {
  const method = normalizePaymentMethod(paymentMethod)
  if (method === PAYMENT_METHODS.COD) {
    const blocked = codBlockedBy(lines)
    if (blocked.length) {
      throw new ApiError(
        400,
        'PAYMENT_METHOD_DISABLED',
        blocked.length === 1
          ? `${blocked[0]} is not available for cash on delivery.`
          : `${blocked.join(', ')} are not available for cash on delivery.`,
        { blockedBy: blocked },
      )
    }
  }
  return method
}

/**
 * Customer-facing fee hints per payment method (display only — charging always goes
 * through calculateCheckoutPricing).
 */
export function computePaymentOptions(lines) {
  const prepared = prepareLines(lines)
  const sum = (fn) => prepared.reduce((acc, l) => acc + fn(l.fees), 0)
  const blockedBy = prepared.filter((l) => !l.fees.codAllowed).map((l) => l.name)
  return {
    prepaid: {
      enabled: true,
      convenienceFeePaise: sum((f) => lineConvenienceFee(f, PAYMENT_METHODS.PREPAID)),
    },
    cod: {
      enabled: blockedBy.length === 0,
      codFeePaise: sum((f) => assertPaise(f.cod.amountPaise, 'COD fee')),
      convenienceFeePaise: sum((f) => lineConvenienceFee(f, PAYMENT_METHODS.COD)),
      blockedBy,
    },
  }
}

/**
 * @param {{
 *   subtotalPaise: number,
 *   discountPaise?: number,
 *   taxPaise?: number,
 *   paymentMethod: 'PREPAID'|'COD',
 *   lines: Array<{ productId: string, name?: string, fees?: object }>,
 * }} input
 */
export function calculateCheckoutPricing({
  subtotalPaise,
  discountPaise = 0,
  taxPaise = 0,
  paymentMethod,
  lines,
}) {
  const method = normalizePaymentMethod(paymentMethod)
  const sub = assertPaise(subtotalPaise, 'subtotal')
  const discount = assertPaise(discountPaise, 'discount')
  const tax = assertPaise(taxPaise, 'tax')
  if (discount > sub) {
    throw new ApiError(500, 'PRICING_ERROR', 'Discount cannot exceed subtotal.')
  }

  const prepared = prepareLines(lines)

  let convenienceFeePaise = 0
  let codFeePaise = 0
  let shippingPaise = 0
  const snapshotLines = []

  for (const line of prepared) {
    const { fees } = line
    const lineConvenience = lineConvenienceFee(fees, method)
    const lineCod =
      method === PAYMENT_METHODS.COD ? assertPaise(fees.cod.amountPaise, 'COD fee') : 0
    const lineShipping = assertPaise(fees.shipping.amountPaise, 'shipping')

    convenienceFeePaise += lineConvenience
    codFeePaise += lineCod
    shippingPaise = Math.max(shippingPaise, lineShipping)

    snapshotLines.push({
      productId: line.productId,
      convenienceFeePaise: lineConvenience,
      codFeePaise: lineCod,
      shippingFeePaise: lineShipping,
      codAllowed: fees.codAllowed,
    })
  }

  const totalPaise = sub - discount + shippingPaise + convenienceFeePaise + codFeePaise + tax
  if (!Number.isSafeInteger(totalPaise) || totalPaise < 0) {
    throw new ApiError(500, 'PRICING_ERROR', 'Could not calculate order total.')
  }

  return {
    currency: 'INR',
    paymentMethod: method,
    subtotalPaise: sub,
    shippingPaise,
    discountPaise: discount,
    taxPaise: tax,
    codFeePaise,
    convenienceFeePaise,
    totalPaise,
    configVersion: null,
    // Per-product fees in force when this price was computed — stored on the order, never re-applied
    pricingSnapshot: {
      feeModel: FEE_MODEL,
      settingsVersion: null,
      lines: snapshotLines,
    },
    // Rupee mirrors for UI / legacy fields
    subtotal: paiseToRupees(sub),
    shipping: paiseToRupees(shippingPaise),
    discount: paiseToRupees(discount),
    codFee: paiseToRupees(codFeePaise),
    convenienceFee: paiseToRupees(convenienceFeePaise),
    total: paiseToRupees(totalPaise),
  }
}
