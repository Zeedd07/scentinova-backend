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
    /** Shown to the customer on the tracking page; `note` stays internal. */
    customerMessage: { type: String, default: null },
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
    paymentMethod: {
      type: String,
      enum: ['PREPAID', 'COD'],
      default: 'PREPAID',
      index: true,
    },
    pricing: {
      currency: { type: String, default: 'INR' },
      subtotalPaise: { type: Number, default: 0 },
      discountPaise: { type: Number, default: 0 },
      taxPaise: { type: Number, default: 0 },
      shippingPaise: { type: Number, default: 0 },
      codFeePaise: { type: Number, default: 0 },
      convenienceFeePaise: { type: Number, default: 0 },
      totalPaise: { type: Number, default: 0 },
      /** Global PricingSettings.version for orders priced before per-product fees; otherwise null. */
      configVersion: { type: Number, default: null },
    },
    /** Fee rules in force when the order was priced — historical, never re-applied. */
    pricingSnapshot: {
      type: new mongoose.Schema(
        {
          /** 'PER_PRODUCT' for current orders; absent on orders priced by global settings. */
          feeModel: { type: String, default: null },
          lines: {
            type: [
              new mongoose.Schema(
                {
                  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
                  convenienceFeePaise: Number,
                  codFeePaise: Number,
                  shippingFeePaise: Number,
                  codAllowed: Boolean,
                },
                { _id: false },
              ),
            ],
            default: undefined,
          },
          // Legacy global-settings snapshot fields
          settingsVersion: { type: Number, default: null },
          shippingEnabled: Boolean,
          shippingStandardFeePaise: Number,
          freeShippingEnabled: Boolean,
          freeShippingThresholdPaise: Number,
          convenienceFeeEnabled: Boolean,
          convenienceFeeConfiguredPaise: Number,
          convenienceFeeAppliesToPrepaid: Boolean,
          convenienceFeeAppliesToCod: Boolean,
          codFeeEnabled: Boolean,
          codFeeConfiguredPaise: Number,
        },
        { _id: false },
      ),
      default: null,
    },
    // Legacy rupee totals / fee mirrors for admin UI
    subtotal: { type: Number, default: null },
    shipping: { type: Number, default: null },
    discount: { type: Number, default: null },
    codFee: { type: Number, default: null },
    convenienceFee: { type: Number, default: null },
    total: { type: Number, default: null },
    currency: { type: String, default: 'INR' },
    payment: {
      provider: { type: String, default: 'razorpay' },
      razorpayOrderId: { type: String },
      razorpayPaymentId: { type: String },
      status: {
        type: String,
        enum: [
          'CREATED',
          'AUTHORIZED',
          'CAPTURED',
          'PENDING',
          'PAID',
          'FAILED',
          'REFUNDED',
          'PARTIALLY_REFUNDED',
          'pending',
          'paid',
          'failed',
          'refunded',
          'not_required',
        ],
        default: 'CREATED',
      },
      method: { type: String, default: null },
      amountPaise: { type: Number, default: null },
      currency: { type: String, default: 'INR' },
      capturedAt: { type: Date, default: null },
      receivedAt: { type: Date, default: null },
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
    /** SHA-256 of short tracking codes sent by email (newest last, capped). */
    trackingCodeHashes: { type: [String], default: [] },
    /** Raw emailed code, only until the confirmation email is accepted by Resend. */
    pendingEmailTrackingCode: { type: String, default: null },
    statusHistory: { type: [statusHistorySchema], default: [] },
    notes: { type: String, default: null },
    customerNote: { type: String, default: null },
    idempotencyKey: { type: String },
    paymentExpiresAt: { type: Date, default: null },
    stockDecremented: { type: Boolean, default: false },
    inventoryCommitted: { type: Boolean, default: false },
    /** Order-confirmation email delivery (Resend) — never blocks order success. */
    confirmationEmailSentAt: { type: Date, default: null },
    confirmationEmailMessageId: { type: String, default: null },
    confirmationEmailStatus: {
      type: String,
      enum: ['pending', 'sending', 'sent', 'failed', 'skipped'],
      default: null,
    },
    confirmationEmailLastError: { type: String, default: null },
    confirmationEmailLockUntil: { type: Date, default: null },
  },
  { timestamps: true },
)

orderSchema.index({ createdAt: -1 })
orderSchema.index({ status: 1 })
orderSchema.index({ 'customerSnapshot.email': 1 })
orderSchema.index({ 'customer.email': 1 })
// Partial unique indexes: sparse + null still indexes null and blocks every unpaid order
orderSchema.index(
  { 'payment.razorpayOrderId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'payment.razorpayOrderId': { $exists: true, $type: 'string' },
    },
  },
)
orderSchema.index(
  { 'payment.razorpayPaymentId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'payment.razorpayPaymentId': { $exists: true, $type: 'string' },
    },
  },
)
orderSchema.index({ 'fulfillment.trackingNumber': 1 })
orderSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $exists: true, $type: 'string' },
    },
  },
)

orderSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id.toString()
    delete ret._id
    delete ret.trackingTokenHash
    delete ret.trackingCodeHashes
    delete ret.pendingEmailTrackingCode
    return ret
  },
})

export const Order = mongoose.model('Order', orderSchema)
