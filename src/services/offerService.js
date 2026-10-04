import mongoose from 'mongoose'
import { MAX_OFFERS, Offer } from '../models/Offer.js'
import { ApiError } from '../utils/ApiError.js'
import { writeAudit } from './auditService.js'

function notFound() {
  return new ApiError(404, 'OFFER_NOT_FOUND', 'That offer was not found.')
}

async function findOffer(id) {
  if (!mongoose.isValidObjectId(id)) throw notFound()
  const offer = await Offer.findById(id)
  if (!offer) throw notFound()
  return offer
}

function audit(action, offer, { adminId, ip }, metadata = {}) {
  return writeAudit({
    actorType: 'ADMIN',
    actorId: adminId ? String(adminId) : null,
    action,
    entityType: 'Offer',
    entityId: offer?._id ?? 'offers',
    metadata,
    ip,
  })
}

/** Storefront: active offers only, in display order, text only. */
export async function listActiveOffers() {
  const offers = await Offer.find({ active: true })
    .sort({ sortOrder: 1, createdAt: 1 })
    .select('text')
    .lean()
  return offers.map((o) => ({ id: String(o._id), text: o.text }))
}

export async function listAllOffers() {
  return Offer.find().sort({ sortOrder: 1, createdAt: 1 })
}

export async function createOffer({ text, active = true }, actor) {
  const count = await Offer.countDocuments()
  if (count >= MAX_OFFERS) {
    throw new ApiError(
      400,
      'OFFER_LIMIT_REACHED',
      `You can have up to ${MAX_OFFERS} offers. Delete one to add another.`,
    )
  }
  const last = await Offer.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean()
  const offer = await Offer.create({ text, active, sortOrder: (last?.sortOrder ?? -1) + 1 })
  await audit('OFFER_CREATED', offer, actor, { text, active })
  return offer
}

export async function updateOffer(id, changes, actor) {
  const offer = await findOffer(id)
  if (changes.text !== undefined) offer.text = changes.text
  if (changes.active !== undefined) offer.active = changes.active
  await offer.save()
  await audit('OFFER_UPDATED', offer, actor, changes)
  return offer
}

export async function deleteOffer(id, actor) {
  const offer = await findOffer(id)
  await offer.deleteOne()
  await audit('OFFER_DELETED', offer, actor, { text: offer.text })
  return { id: String(offer._id) }
}

/** `ids` must list every offer exactly once, in the new display order. */
export async function reorderOffers(ids, actor) {
  const offers = await Offer.find().select('_id').lean()
  const existing = new Set(offers.map((o) => String(o._id)))
  const unique = new Set(ids)
  if (unique.size !== ids.length || ids.length !== existing.size || ids.some((id) => !existing.has(id))) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'The offer list changed. Refresh the page and try again.',
    )
  }
  await Offer.bulkWrite(
    ids.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index } } },
    })),
  )
  await audit('OFFERS_REORDERED', null, actor, { ids })
  return listAllOffers()
}
