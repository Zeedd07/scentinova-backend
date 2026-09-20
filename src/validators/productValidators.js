import { z } from 'zod'

const notesSchema = z.object({
  top: z.array(z.string()).optional().default([]),
  heart: z.array(z.string()).optional().default([]),
  base: z.array(z.string()).optional().default([]),
})

/** Required INR price — coerces numeric strings from JSON/forms. */
const priceSchema = z.coerce
  .number({
    required_error: 'Price is required.',
    invalid_type_error: 'Price must be a number.',
  })
  .finite()
  .min(0, 'Price cannot be negative.')

export const productCreateSchema = z.object({
  name: z.string().min(1, 'Name is required.'),
  slug: z.string().min(1).optional(),
  tagline: z.string().optional().default(''),
  description: z.string().optional().default(''),
  story: z.string().optional().default(''),
  price: priceSchema,
  currency: z.string().optional().default('INR'),
  size: z.string().optional().default('50ML'),
  concentration: z.string().optional().default('Parfum'),
  category: z.string().optional().default(''),
  featured: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
  badge: z.union([z.string(), z.null()]).optional().default(null),
  image: z.string().optional().default(''),
  imagePublicId: z.union([z.string(), z.null()]).optional().default(null),
  gallery: z.array(z.string()).optional().default([]),
  galleryPublicIds: z.array(z.string()).optional().default([]),
  notes: notesSchema.optional().default({ top: [], heart: [], base: [] }),
  descriptors: z.array(z.string()).optional().default([]),
  stock: z.number().int().min(0).optional().default(0),
  accent: z.string().optional().default(''),
})

export const productUpdateSchema = productCreateSchema.partial()
