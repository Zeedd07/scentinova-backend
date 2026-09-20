import mongoose from 'mongoose'

const shipmentEventSchema = new mongoose.Schema(
  {
    status: String,
    location: String,
    description: String,
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
)

const shipmentSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      unique: true,
    },
    provider: { type: String, default: 'manual' },
    shipmentId: { type: String, default: null },
    carrier: { type: String, default: null },
    trackingNumber: { type: String, default: null, index: true },
    trackingUrl: { type: String, default: null },
    status: {
      type: String,
      enum: [
        'CREATED',
        'PICKED_UP',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'EXCEPTION',
        'CANCELLED',
        'RETURNED',
      ],
      default: 'CREATED',
    },
    estimatedDelivery: { type: Date, default: null },
    shippedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    events: { type: [shipmentEventSchema], default: [] },
  },
  { timestamps: true },
)

export const Shipment = mongoose.model('Shipment', shipmentSchema)
