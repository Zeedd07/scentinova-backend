/**
 * Integer paise money helpers — never use floats for charge amounts.
 */

export function rupeesToPaise(rupees) {
  const n = Number(rupees)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Invalid rupee amount')
  }
  return Math.round(n * 100)
}

export function paiseToRupees(paise) {
  const n = Number(paise)
  if (!Number.isFinite(n)) return 0
  return n / 100
}

export function formatPaiseInr(paise) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paiseToRupees(paise))
}

/** Assert a chargeable paise amount (Razorpay minimum often 100 paise = ₹1). */
export function assertChargeablePaise(paise, { min = 100 } = {}) {
  const n = Number(paise)
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Amount must be an integer >= ${min} paise`)
  }
  return n
}
