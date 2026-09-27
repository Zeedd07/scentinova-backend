import mongoose from 'mongoose'

const notesSchema = new mongoose.Schema(
  {
    top: { type: [String], default: [] },
    heart: { type: [String], default: [] },
    base: { type: [String], default: [] },
  },
  { _id: false },
)

/**
 * Per-product note image override. Notes themselves stay plain strings in `notes`;
 * entries are matched by tier + normalized note name.
 */
const noteImageSchema = new mongoose.Schema(
  {
    tier: { type: String, enum: ['TOP', 'HEART', 'BASE'], required: true },
    noteKey: { type: String, required: true, trim: true, lowercase: true },
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    alt: { type: String, default: null, trim: true, maxlength: 200 },
    /** Suppress the global default image for this note on this product. */
    hideImage: { type: Boolean, default: false },
  },
  { _id: false },
)

const feeAmountSchema = (extra = {}) =>
  new mongoose.Schema(
    {
      enabled: { type: Boolean, default: false },
      amountPaise: { type: Number, default: 0, min: 0 },
      ...extra,
    },
    { _id: false },
  )

/**
 * Checkout charges configured on this product (paise). Missing fields on legacy
 * documents resolve to "no fee, COD allowed" via defaults.
 */
const productFeesSchema = new mongoose.Schema(
  {
    convenience: {
      type: feeAmountSchema({
        applyToPrepaid: { type: Boolean, default: true },
        applyToCod: { type: Boolean, default: true },
      }),
      default: () => ({}),
    },
    cod: { type: feeAmountSchema(), default: () => ({}) },
    shipping: { type: feeAmountSchema(), default: () => ({}) },
    codAllowed: { type: Boolean, default: true },
  },
  { _id: false },
)

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    sku: { type: String, default: null, trim: true, uppercase: true },
    tagline: { type: String, default: '' },
    description: { type: String, default: '' },
    story: { type: String, default: '' },

    /**
     * Authoritative charge amount in paise (₹1 = 100).
     * `price` (rupees) is kept in sync for admin/UI compatibility.
     */
    pricePaise: { type: Number, required: true, min: 0 },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    fees: { type: productFeesSchema, default: () => ({}) },

    size: { type: String, default: '50ML' },
    concentration: { type: String, default: 'Parfum' },
    category: { type: String, default: '' },
    featured: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    badge: { type: String, default: null },

    image: { type: String, default: '' },
    imagePublicId: { type: String, default: null },
    gallery: { type: [String], default: [] },
    galleryPublicIds: { type: [String], default: [] },

    notes: { type: notesSchema, default: () => ({ top: [], heart: [], base: [] }) },
    descriptors: { type: [String], default: [] },
    noteImages: { type: [noteImageSchema], default: [] },
    /** Admin-only AI background / reference image (MediaAsset type PRODUCT_BACKGROUND). */
    backgroundAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },

    stock: { type: Number, default: 0, min: 0 },
    trackInventory: { type: Boolean, default: true },
    allowBackorder: { type: Boolean, default: false },

    accent: { type: String, default: '' },
  },
  { timestamps: true },
)

productSchema.index({ category: 1 })
productSchema.index({ featured: 1 })
productSchema.index({ active: 1 })
productSchema.index({ createdAt: -1 })
productSchema.index({ imagePublicId: 1 })
productSchema.index({ 'noteImages.assetId': 1 })
productSchema.index({ backgroundAssetId: 1 })
productSchema.index({ sku: 1 }, { unique: true, sparse: true })

productSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id.toString()
    delete ret._id
    return ret
  },
})

export const Product = mongoose.model('Product', productSchema)
