import mongoose from 'mongoose'

const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, default: 'razorpay' },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    payloadHash: { type: String, default: null },
    processedAt: { type: Date, default: null },
    rawSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
)

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true })

export const WebhookEvent = mongoose.model('WebhookEvent', webhookEventSchema)
