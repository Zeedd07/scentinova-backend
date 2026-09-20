import { z } from 'zod'

export const newsletterSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
})

export const analyticsEventSchema = z.object({
  type: z.enum(['product_view', 'add_to_cart', 'checkout_started']),
  productId: z.string().optional().nullable(),
  sessionId: z.string().optional().nullable(),
  metadata: z.record(z.any()).optional().default({}),
})
