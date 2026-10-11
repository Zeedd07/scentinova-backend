import mongoose from 'mongoose'
import { MAX_SALES, Sale } from '../models/Sale.js'
import { Product } from '../models/Product.js'
import { ApiError } from '../utils/ApiError.js'
import { paiseToRupees, rupeesToPaise } from '../utils/money.js'
import { writeAudit } from './auditService.js'

export const SALE_STATUS = Object.freeze({
  LIVE: 'LIVE',
  SCHEDULED: 'SCHEDULED',
  ENDED: 'ENDED',
  OFF: 'OFF',
})

function notFound() {
  return new ApiError(404, 'SALE_NOT_FOUND', 'That sale was not found.')
}

async function findSale(id) {
  if (!mongoose.isValidObjectId(id)) throw notFound()
  const sale = await Sale.findById(id)
  if (!sale) throw notFound()
  return sale
}

function audit(action, sale, { adminId, ip }, metadata = {}) {
  return writeAudit({
    actorType: 'ADMIN',
    actorId: adminId ? String(adminId) : null,
    action,
    entityType: 'Sale',
    entityId: sale._id,
    metadata,
    ip,
  })
}

export function saleStatus(sale, now = new Date()) {
  if (!sale.active) return SALE_STATUS.OFF
  if (sale.endsAt && new Date(sale.endsAt) <= now) return SALE_STATUS.ENDED
  if (sale.startsAt && new Date(sale.startsAt) > now) return SALE_STATUS.SCHEDULED
  return SALE_STATUS.LIVE
}

/** Sale price rounded to the nearest whole rupee. */
export function salePricePaise(pricePaise, percentOff) {
  return Math.round((pricePaise * (100 - percentOff)) / 10000) * 100
}

/** Sales switched on whose start has passed (or is unset) and whose end has not (or is unset). */
export async function getLiveSales(now = new Date()) {
  return Sale.find({
    active: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
    ],
  }).lean()
}

/** The best live sale covering a product: highest percentage wins, sales never stack. */
export function saleForProduct(productId, liveSales) {
  const id = String(productId)
  let best = null
  for (const sale of liveSales) {
    const covers =
      sale.appliesTo === 'ALL' || (sale.productIds || []).some((p) => String(p) === id)
    if (!covers) continue
    if (
      !best ||
      sale.percentOff > best.percentOff ||
      (sale.percentOff === best.percentOff && sale.createdAt > best.createdAt)
    ) {
      best = sale
    }
  }
  return best
}

/** Label customers see for a product's own discount (cart line, checkout, emails). */
export const PRODUCT_DISCOUNT_LABEL = 'Special price'

/** Unit price after the product's own discount, or null when it has none. */
export function productDiscountPricePaise(product, pricePaise) {
  const discount = product?.discount
  if (discount?.type === 'PERCENT' && discount.percentOff > 0) {
    return salePricePaise(pricePaise, discount.percentOff)
  }
  if (discount?.type === 'PRICE' && discount.salePricePaise > 0) {
    return Math.round(discount.salePricePaise)
  }
  return null
}

/**
 * Best price for one unit of a product: the product's own discount or the best live
 * festival sale, whichever is lower. They never stack; a tie goes to the festival sale.
 * @returns {{ sale: { kind: 'SALE'|'PRODUCT', name: string, percentOff: number, endsAt: Date|null }, salePricePaise: number, unitDiscountPaise: number } | null}
 */
export function priceWithSale(product, pricePaise, liveSales) {
  if (!Number.isSafeInteger(pricePaise) || pricePaise <= 0) return null
  const candidates = []

  const sale = saleForProduct(product._id ?? product.id, liveSales)
  if (sale) {
    candidates.push({
      sale: {
        kind: 'SALE',
        name: sale.name,
        percentOff: sale.percentOff,
        endsAt: sale.endsAt ?? null,
      },
      price: salePricePaise(pricePaise, sale.percentOff),
    })
  }

  const own = productDiscountPricePaise(product, pricePaise)
  if (own != null) {
    candidates.push({
      sale: {
        kind: 'PRODUCT',
        name: PRODUCT_DISCOUNT_LABEL,
        percentOff: Math.max(1, Math.round(((pricePaise - own) / pricePaise) * 100)),
        endsAt: null,
      },
      price: own,
    })
  }

  let best = null
  for (const c of candidates) {
    if (c.price < 0 || c.price >= pricePaise) continue
    if (!best || c.price < best.price) best = c
  }
  if (!best) return null
  return { sale: best.sale, salePricePaise: best.price, unitDiscountPaise: pricePaise - best.price }
}

/** Storefront summary of the sale on a product (null when none). */
export function publicSaleFor(product, liveSales) {
  let pricePaise = null
  if (product.pricePaise != null) pricePaise = Math.round(Number(product.pricePaise))
  else if (Number(product.price) > 0) pricePaise = rupeesToPaise(product.price)
  const priced = priceWithSale(product, pricePaise, liveSales)
  if (!priced) return null
  return {
    kind: priced.sale.kind,
    name: priced.sale.name,
    percentOff: priced.sale.percentOff,
    pricePaise: priced.salePricePaise,
    price: paiseToRupees(priced.salePricePaise),
    endsAt: priced.sale.endsAt ?? null,
  }
}

function toAdmin(sale, now = new Date()) {
  return { ...sale.toJSON(), status: saleStatus(sale, now) }
}

async function assertValidSale(sale) {
  if (sale.startsAt && sale.endsAt && sale.endsAt <= sale.startsAt) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The end date must be after the start date.')
  }
  if (sale.appliesTo !== 'PRODUCTS') return
  const ids = [...new Set((sale.productIds || []).map(String))]
  if (!ids.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose at least one product for this sale.')
  }
  const found = await Product.countDocuments({ _id: { $in: ids } })
  if (found !== ids.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'One of the selected products no longer exists.')
  }
}

function applyChanges(sale, changes) {
  for (const key of ['name', 'percentOff', 'appliesTo', 'active']) {
    if (changes[key] !== undefined) sale[key] = changes[key]
  }
  if (changes.productIds !== undefined) sale.productIds = [...new Set(changes.productIds)]
  if (changes.startsAt !== undefined) sale.startsAt = changes.startsAt ? new Date(changes.startsAt) : null
  if (changes.endsAt !== undefined) sale.endsAt = changes.endsAt ? new Date(changes.endsAt) : null
  if (sale.appliesTo === 'ALL') sale.productIds = []
}

export async function listAllSales() {
  const now = new Date()
  const sales = await Sale.find().sort({ createdAt: -1 })
  return sales.map((s) => toAdmin(s, now))
}

export async function createSale(input, actor) {
  const count = await Sale.countDocuments()
  if (count >= MAX_SALES) {
    throw new ApiError(
      400,
      'SALE_LIMIT_REACHED',
      `You can have up to ${MAX_SALES} sales. Delete an old one to add another.`,
    )
  }
  const sale = new Sale({ active: true })
  applyChanges(sale, input)
  await assertValidSale(sale)
  await sale.save()
  await audit('SALE_CREATED', sale, actor, {
    name: sale.name,
    percentOff: sale.percentOff,
    appliesTo: sale.appliesTo,
  })
  return toAdmin(sale)
}

export async function updateSale(id, changes, actor) {
  const sale = await findSale(id)
  applyChanges(sale, changes)
  await assertValidSale(sale)
  await sale.save()
  await audit('SALE_UPDATED', sale, actor, changes)
  return toAdmin(sale)
}

export async function deleteSale(id, actor) {
  const sale = await findSale(id)
  await sale.deleteOne()
  await audit('SALE_DELETED', sale, actor, { name: sale.name })
  return { id: String(sale._id) }
}
