import mongoose from 'mongoose'
import { ORDER_STATUSES } from '../utils/orderStatus.js'

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    sku: { type: String, default: null },
    slug: String,
    name: String,
    image: String,
    size: String,
    concentration: String,
    quantity: { type: Number, required: true, min: 1 },
    unitPricePaise: { type: Number, required: true, min: 0 },
    subtotalPaise: { type: Number, required: true, min: 0 },
    discountPaise: { type: Number, default: 0 },
    taxPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true, min: 0 },
    // Legacy display fields (rupees) — filled for older admin UI
    unitPrice: { type: Number, default: null },
    lineTotal: { type: Number, default: null },
  },
  { _id: false },
)

const statusHistorySchema = new mongoose.Schema(
  {
    previousStatus: { type: String, default: null },
    status: { type: String, required: true },
    changedBy: { type: String, default: null },
    source: {
      type: String,
      enum: ['ADMIN', 'CUSTOMER', 'SYSTEM', 'RAZORPAY_WEBHOOK'],
      default: 'SYSTEM',
    },
    note: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerSnapshot: {
      firstName: { type: String, default: '' },
      lastName: { type: String, default: '' },
      name: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, default: null },
    },
    // Legacy nested customer for older documents / admin list
    customer: {
      name: String,
      email: String,
      phone: String,
    },
    shippingAddress: {
      fullName: { type: String, default: '' },
      phone: { type: String, default: null },
      addressLine1: { type: String, default: '' },
      addressLine2: { type: String, default: null },
      landmark: { type: String, default: null },
      city: { type: String, default: null },
      state: { type: String, default: null },
      postalCode: { type: String, default: null },
      country: { type: String, default: 'India' },
      // Legacy
      line1: String,
      line2: String,
    },
    billingAddress: { type: mongoose.Schema.Types.Mixed, default: null },
    items: { type: [orderItemSchema], required: true },
    pricing: {
      currency: { type: String, default: 'INR' },
      subtotalPaise: { type: Number, default: 0 },
      discountPaise: { type: Number, default: 0 },
      taxPaise: { type: Number, default: 0 },
      shippingPaise: { type: Number, default: 0 },
      totalPaise: { type: Number, default: 0 },
    },
    // Legacy rupee totals
    subtotal: { type: Number, default: null },
    shipping: { type: Number, default: null },
    total: { type: Number, default: null },
    currency: { type: String, default: 'INR' },
    payment: {
      provider: { type: String, default: 'razorpay' },
      razorpayOrderId: { type: String, default: null },
      razorpayPaymentId: { type: String, default: null },
      status: {
        type: String,
        enum: ['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'pending', 'paid', 'failed', 'refunded', 'not_required'],
        default: 'CREATED',
      },
      method: { type: String, default: null },
      amountPaise: { type: Number, default: null },
      currency: { type: String, default: 'INR' },
      capturedAt: { type: Date, default: null },
      failedAt: { type: Date, default: null },
      failureReason: { type: String, default: null },
    },
    fulfillment: {
      status: {
        type: String,
        enum: ['unfulfilled', 'partial', 'fulfilled', 'cancelled', 'CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED'],
        default: 'unfulfilled',
      },
      carrier: { type: String, default: null },
      shipmentId: { type: String, default: null },
      trackingNumber: { type: String, default: null },
      trackingUrl: { type: String, default: null },
      shippedAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
    },
    status: {
      type: String,
      enum: [...ORDER_STATUSES, 'new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'],
      default: 'PENDING_PAYMENT',
    },
    // Legacy top-level payment/fulfillment
    paymentStatus: { type: String, default: null },
    fulfillmentStatus: { type: String, default: null },
    orderType: { type: String, default: 'priced' },
    trackingTokenHash: { type: String, default: null, index: true },
    statusHistory: { type: [statusHistorySchema], default: [] },
    notes: { type: String, default: null },
    customerNote: { type: String, default: null },
    idempotencyKey: { type: String, default: null },
    paymentExpiresAt: { type: Date, default: null },
    stockDecremented: { type: Boolean, default: false },
    inventoryCommitted: { type: Boolean, default: false },
  },
  { timestamps: true },
)

orderSchema.index({ createdAt: -1 })
orderSchema.index({ status: 1 })
orderSchema.index({ 'customerSnapshot.email': 1 })
orderSchema.index({ 'customer.email': 1 })
orderSchema.index({ 'payment.razorpayOrderId': 1 }, { unique: true, sparse: true })
orderSchema.index({ 'payment.razorpayPaymentId': 1 }, { unique: true, sparse: true })
orderSchema.index({ 'fulfillment.trackingNumber': 1 })
orderSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true })

orderSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id.toString()
    delete ret._id
    delete ret.trackingTokenHash
    return ret
  },
})

export const Order = mongoose.model('Order', orderSchema)
