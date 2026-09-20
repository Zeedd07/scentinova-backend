import { z } from 'zod'

const cartItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(20),
  unitPricePaise: z.coerce.number().int().optional(),
})

export const checkoutQuoteSchema = z.object({
  items: z.array(cartItemSchema).min(1),
  expectedTotalPaise: z.coerce.number().int().optional(),
})

export const checkoutCreateSchema = z.object({
  customer: z.object({
    name: z.string().min(1, 'Name is required.'),
    email: z.string().email('Enter a valid email address.'),
    phone: z.string().min(8).max(20).optional().nullable(),
  }),
  shippingAddress: z.object({
    fullName: z.string().min(1).optional(),
    phone: z.string().min(8).max(20).optional().nullable(),
    addressLine1: z.string().min(1, 'Address is required.'),
    addressLine2: z.string().optional().nullable(),
    line1: z.string().optional(),
    line2: z.string().optional().nullable(),
    landmark: z.string().optional().nullable(),
    city: z.string().min(1, 'City is required.'),
    state: z.string().min(1, 'State is required.'),
    postalCode: z.string().min(4, 'Postal code is required.'),
    country: z.string().optional().default('India'),
  }),
  items: z.array(cartItemSchema).min(1),
  customerNote: z.string().max(500).optional().nullable(),
})

export const paymentVerifySchema = z.object({
  orderNumber: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
})

export const paymentFailedSchema = z.object({
  orderNumber: z.string().min(1),
  reason: z.string().optional(),
})

export const adminOrderStatusSchema = z.object({
  status: z.enum([
    'PROCESSING',
    'PACKED',
    'SHIPPED',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'CANCELLED',
    'REFUND_PENDING',
  ]),
  note: z.string().optional().nullable(),
  shipping: z
    .object({
      carrier: z.string().optional(),
      trackingNumber: z.string().optional(),
      trackingUrl: z.string().url().optional().nullable(),
    })
    .optional(),
})

export const adminShippingSchema = z.object({
  carrier: z.string().min(1),
  trackingNumber: z.string().min(1),
  trackingUrl: z.string().url().optional().nullable(),
  shipmentId: z.string().optional().nullable(),
})

export const adminRefundSchema = z.object({
  amountPaise: z.coerce.number().int().min(100).optional(),
  reason: z.string().max(500).optional().nullable(),
})
