import { z } from 'zod'

export const orderCreateSchema = z.object({
  customer: z.object({
    name: z.string().min(1, 'Name is required.'),
    email: z.string().email('Enter a valid email address.'),
    phone: z.string().optional().nullable(),
  }),
  shippingAddress: z.object({
    line1: z.string().min(1, 'Address is required.'),
    line2: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    state: z.string().optional().nullable(),
    postalCode: z.string().optional().nullable(),
    country: z.string().optional().default('India'),
  }),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1).max(20),
      }),
    )
    .min(1, 'Add at least one fragrance.'),
  customerNote: z.string().optional().nullable(),
})

export const orderStatusSchema = z.object({
  status: z.enum(['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled']),
})
