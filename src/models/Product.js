import mongoose from 'mongoose'

const notesSchema = new mongoose.Schema(
  {
    top: { type: [String], default: [] },
    heart: { type: [String], default: [] },
    base: { type: [String], default: [] },
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
