import mongoose from 'mongoose'

const paymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    orderNumber: { type: String, required: true, index: true },
    provider: { type: String, default: 'razorpay' },
    razorpayOrderId: { type: String, default: null, index: true },
    razorpayPaymentId: { type: String, default: null, unique: true, sparse: true },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: {
      type: String,
      enum: ['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
      default: 'CREATED',
    },
    method: { type: String, default: null },
    capturedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    refundIds: { type: [String], default: [] },
    refundedPaise: { type: Number, default: 0 },
  },
  { timestamps: true },
)

paymentSchema.index({ razorpayOrderId: 1 }, { sparse: true })

export const Payment = mongoose.model('Payment', paymentSchema)
