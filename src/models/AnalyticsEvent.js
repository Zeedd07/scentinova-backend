import mongoose from 'mongoose'

const analyticsEventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['product_view', 'add_to_cart', 'checkout_started', 'order_created'],
      required: true,
    },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    sessionId: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

analyticsEventSchema.index({ type: 1, createdAt: -1 })
analyticsEventSchema.index({ productId: 1, type: 1 })
analyticsEventSchema.index({ sessionId: 1, type: 1, productId: 1, createdAt: -1 })

export const AnalyticsEvent = mongoose.model('AnalyticsEvent', analyticsEventSchema)
