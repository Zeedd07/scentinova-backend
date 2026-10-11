import { z } from 'zod'

const cartItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(20),
  unitPricePaise: z.coerce.number().int().optional(),
})

/** Trimmed free text; blank becomes null. */
function optionalText(max) {
  return z
    .string()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v && v.trim() ? v.trim() : null))
}

const paymentMethodSchema = z
  .enum(['PREPAID', 'COD', 'prepaid', 'cod'])
  .optional()
  .transform((v) => (v ? String(v).toUpperCase() : 'PREPAID'))

export const checkoutQuoteSchema = z.object({
  items: z.array(cartItemSchema).min(1),
  paymentMethod: paymentMethodSchema,
  expectedTotalPaise: z.coerce.number().int().optional(),
})

export const ADDRESS_PART_MAX = 120

/** Address part; whitespace collapsed, blank becomes null. */
function addressPart(label) {
  return z
    .string()
    .max(ADDRESS_PART_MAX, `${label} must be ${ADDRESS_PART_MAX} characters or fewer.`)
    .optional()
    .nullable()
    .transform((v) => {
      const clean = String(v || '').trim().replace(/\s+/g, ' ')
      return clean || null
    })
}

/** Required parts of a structured address, with the message shown under each field. */
const REQUIRED_ADDRESS_PARTS = [
  ['houseNumber', 'Enter your flat, house or room number.'],
  ['building', 'Enter your building or house name.'],
  ['area', 'Enter your street, area or locality.'],
]

const shippingAddressSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    phone: z.string().min(8).max(20).optional().nullable(),
    houseNumber: addressPart('Flat / house no.'),
    building: addressPart('Building name'),
    area: addressPart('Street / area'),
    landmark: addressPart('Landmark'),
    // Single-line format sent by older storefront builds
    addressLine1: z.string().optional().nullable(),
    addressLine2: z.string().optional().nullable(),
    line1: z.string().optional(),
    line2: z.string().optional().nullable(),
    city: z.string().min(1, 'City is required.'),
    state: z.string().min(1, 'State is required.'),
    postalCode: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit PIN code.'),
    country: z.string().optional().default('India'),
  })
  .superRefine((a, ctx) => {
    const structured = REQUIRED_ADDRESS_PARTS.some(([key]) => a[key])
    const legacyLine = String(a.addressLine1 || a.line1 || '').trim()
    if (!structured && legacyLine) return
    for (const [key, message] of REQUIRED_ADDRESS_PARTS) {
      if (!a[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message })
    }
  })

export const checkoutCreateSchema = z.object({
  paymentMethod: paymentMethodSchema,
  customer: z.object({
    name: z.string().min(1, 'Name is required.'),
    email: z.string().email('Enter a valid email address.'),
    phone: z.string().min(8).max(20).optional().nullable(),
  }),
  shippingAddress: shippingAddressSchema,
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
  note: optionalText(500),
  customerMessage: optionalText(280),
  shipping: z
    .object({
      carrier: z.string().optional(),
      trackingNumber: z.string().optional(),
      trackingUrl: z.string().url().optional().nullable(),
    })
    .optional(),
})

export const adminOrderUpdateSchema = z
  .object({
    customerMessage: optionalText(280),
    note: optionalText(500),
  })
  .refine((v) => v.customerMessage || v.note, {
    message: 'Write a customer message or an internal note.',
    path: ['customerMessage'],
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
