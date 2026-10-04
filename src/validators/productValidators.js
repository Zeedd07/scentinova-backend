import { z } from 'zod'

const notesSchema = z.object({
  top: z.array(z.string()).optional().default([]),
  heart: z.array(z.string()).optional().default([]),
  base: z.array(z.string()).optional().default([]),
})

const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid asset id.')

const noteImageSchema = z.object({
  tier: z.enum(['TOP', 'HEART', 'BASE']),
  noteKey: z.string().trim().min(1).max(80),
  assetId: z.union([objectIdString, z.null()]).optional().default(null),
  alt: z.union([z.string().trim().max(200), z.null()]).optional().default(null),
  hideImage: z.boolean().optional().default(false),
})

export const MAX_PRODUCT_VIDEOS = 6

const httpsUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => /^https:\/\//i.test(v), 'Must be an https URL.')

/** Video uploaded via /admin/uploads/video; only product-folder Cloudinary ids. */
const productVideoSchema = z
  .object({
    publicId: z
      .string()
      .trim()
      .regex(/^scentinova\/products\/[a-z0-9/_-]+$/i, 'Invalid video id.')
      .max(300),
    url: httpsUrl,
    posterUrl: z.union([httpsUrl, z.null()]).optional().default(null),
    width: z.union([z.number().int().min(0), z.null()]).optional().default(null),
    height: z.union([z.number().int().min(0), z.null()]).optional().default(null),
    duration: z.union([z.number().min(0), z.null()]).optional().default(null),
  })
  .strip()

/** ₹10,000 ceiling per fee guards against rupee/paise mix-ups in the admin form. */
export const MAX_PRODUCT_FEE_PAISE = 1_000_000

const feeAmountPaise = z
  .number({ invalid_type_error: 'Fee must be a number.' })
  .int('Fee must be a whole number of paise.')
  .min(0, 'Fee cannot be negative.')
  .max(MAX_PRODUCT_FEE_PAISE, 'Fee cannot exceed ₹10,000.')

const feeSchema = z.object({
  enabled: z.boolean().optional().default(false),
  amountPaise: feeAmountPaise.optional().default(0),
})

const productFeesSchema = z.object({
  convenience: feeSchema
    .extend({
      applyToPrepaid: z.boolean().optional().default(true),
      applyToCod: z.boolean().optional().default(true),
    })
    .optional()
    .default({}),
  cod: feeSchema.optional().default({}),
  shipping: feeSchema.optional().default({}),
  codAllowed: z.boolean().optional().default(true),
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
  galleryScales: z
    .array(
      z
        .number({ invalid_type_error: 'Image size must be a number.' })
        .min(0.5, 'Image size cannot go below 50%.')
        .max(2, 'Image size cannot go above 200%.'),
    )
    .max(30)
    .optional(),
  videos: z.array(productVideoSchema).max(MAX_PRODUCT_VIDEOS, `Up to ${MAX_PRODUCT_VIDEOS} videos.`).optional(),
  notes: notesSchema.optional().default({ top: [], heart: [], base: [] }),
  descriptors: z.array(z.string()).optional().default([]),
  stock: z.number().int().min(0).optional().default(0),
  accent: z.string().optional().default(''),
  noteImages: z.array(noteImageSchema).max(90).optional(),
  backgroundAssetId: z.union([objectIdString, z.null()]).optional(),
  fees: productFeesSchema.optional(),
})

export const productUpdateSchema = productCreateSchema.partial()
