import mongoose from 'mongoose'

export const MEDIA_TYPES = ['NOTE', 'PRODUCT_BACKGROUND', 'PRODUCT_IMAGE', 'OTHER']
export const MEDIA_CATEGORIES = [
  'FLORAL',
  'CITRUS',
  'WOODY',
  'AMBER',
  'MUSK',
  'SPICY',
  'FRESH',
  'GOURMAND',
  'LEATHER',
  'FRUITY',
  'GREEN',
  'OTHER',
]

const mediaAssetSchema = new mongoose.Schema(
  {
    type: { type: String, enum: MEDIA_TYPES, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** Normalized note name (e.g. "jasmine-sambac"); NOTE assets only. */
    noteKey: { type: String, default: null, trim: true, lowercase: true },
    /** Global default image for its noteKey (at most one per key). */
    isDefault: { type: Boolean, default: false },
    category: { type: String, enum: MEDIA_CATEGORIES, default: 'OTHER' },
    publicId: { type: String, required: true, trim: true },
    folder: { type: String, required: true },
    /** Original Cloudinary secure_url; optimized URLs are built from publicId. */
    url: { type: String, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    format: { type: String, default: null },
    bytes: { type: Number, default: null },
    altText: { type: String, default: '', trim: true, maxlength: 200 },
    tags: { type: [String], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true },
)

mediaAssetSchema.index({ publicId: 1 }, { unique: true })
mediaAssetSchema.index({ type: 1, category: 1, createdAt: -1 })
mediaAssetSchema.index({ type: 1, noteKey: 1 })
mediaAssetSchema.index(
  { noteKey: 1 },
  {
    name: 'unique_default_per_note',
    unique: true,
    partialFilterExpression: { isDefault: true, type: 'NOTE' },
  },
)

mediaAssetSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id.toString()
    delete ret._id
    return ret
  },
})

export const MediaAsset = mongoose.model('MediaAsset', mediaAssetSchema)
