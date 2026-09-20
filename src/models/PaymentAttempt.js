import mongoose from 'mongoose'

const paymentAttemptSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    provider: { type: String, default: 'razorpay' },
    razorpayOrderId: { type: String, default: null, index: true },
    razorpayPaymentId: { type: String, default: null },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: {
      type: String,
      enum: ['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED'],
      default: 'CREATED',
    },
    method: { type: String, default: null },
    failureCode: { type: String, default: null },
    failureDescription: { type: String, default: null },
  },
  { timestamps: true },
)

export const PaymentAttempt = mongoose.model('PaymentAttempt', paymentAttemptSchema)
