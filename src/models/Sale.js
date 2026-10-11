import mongoose from 'mongoose'

export const SALE_NAME_MAX = 60
export const SALE_PERCENT_MIN = 1
export const SALE_PERCENT_MAX = 90
export const MAX_SALES = 20
export const SALE_SCOPES = Object.freeze(['ALL', 'PRODUCTS'])

/** A percentage-off sale (e.g. "Diwali Sale, 20% off") for every product or a chosen few. */
const saleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: SALE_NAME_MAX },
    percentOff: {
      type: Number,
      required: true,
      min: SALE_PERCENT_MIN,
      max: SALE_PERCENT_MAX,
      validate: { validator: Number.isInteger, message: 'Percent off must be a whole number.' },
    },
    appliesTo: { type: String, enum: SALE_SCOPES, default: 'ALL' },
    productIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }], default: [] },
    active: { type: Boolean, default: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
  },
  { timestamps: true },
)

saleSchema.index({ active: 1, startsAt: 1, endsAt: 1 })

saleSchema.set('toJSON', {
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id.toString()
    delete ret._id
    ret.productIds = (ret.productIds || []).map(String)
    return ret
  },
})

export const Sale = mongoose.model('Sale', saleSchema)
