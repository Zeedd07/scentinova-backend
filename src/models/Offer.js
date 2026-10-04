import mongoose from 'mongoose'

export const OFFER_TEXT_MAX = 120
export const MAX_OFFERS = 10

/** A short message shown in the storefront announcement bar. */
const offerSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, minlength: 1, maxlength: OFFER_TEXT_MAX },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
)

offerSchema.index({ active: 1, sortOrder: 1 })

offerSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id.toString()
    delete ret._id
    return ret
  },
})

export const Offer = mongoose.model('Offer', offerSchema)
