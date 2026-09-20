import mongoose from 'mongoose'

const reservationSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    quantity: { type: Number, required: true, min: 1 },
    expiresAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'],
      default: 'ACTIVE',
      index: true,
    },
  },
  { timestamps: true },
)

reservationSchema.index({ orderId: 1, productId: 1, status: 1 })

export const InventoryReservation = mongoose.model(
  'InventoryReservation',
  reservationSchema,
)
