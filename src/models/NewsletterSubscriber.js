import mongoose from 'mongoose'

const newsletterSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    status: { type: String, enum: ['subscribed', 'unsubscribed'], default: 'subscribed' },
    subscribedAt: { type: Date, default: Date.now },
    unsubscribedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

newsletterSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id.toString()
    delete ret._id
    return ret
  },
})

export const NewsletterSubscriber = mongoose.model(
  'NewsletterSubscriber',
  newsletterSchema,
)
