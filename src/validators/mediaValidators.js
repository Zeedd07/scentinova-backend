import { z } from 'zod'
import { MEDIA_CATEGORIES, MEDIA_TYPES } from '../models/MediaAsset.js'

const tagsSchema = z
  .union([z.array(z.string().max(40)), z.string().max(400)])
  .optional()
  .transform((v) => (typeof v === 'string' ? v.split(',') : v))

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'on'])])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1' || v === 'on'))

/** Multipart fields accompanying POST /admin/media/upload. */
export const mediaUploadSchema = z.object({
  type: z.enum(MEDIA_TYPES, { errorMap: () => ({ message: 'Choose an asset type.' }) }),
  name: z.string().trim().min(1, 'Name is required.').max(120),
  category: z.enum(MEDIA_CATEGORIES).optional().default('OTHER'),
  altText: z.string().trim().max(200).optional().default(''),
  tags: tagsSchema,
  makeDefault: booleanish,
})

export const mediaUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required.').max(120).optional(),
    category: z.enum(MEDIA_CATEGORIES).optional(),
    altText: z.string().trim().max(200).optional(),
    tags: tagsSchema,
    isDefault: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to update.',
  })

export const mediaListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
  type: z.enum(MEDIA_TYPES).optional(),
  category: z.enum(MEDIA_CATEGORIES).optional(),
  search: z.string().max(80).optional(),
})

const shortText = z.string().trim().max(160)

export const notePromptSchema = z.object({
  noteName: z.string().trim().min(1, 'Note name is required.').max(80),
  category: z.enum(MEDIA_CATEGORIES).optional(),
  tier: z.enum(['TOP', 'HEART', 'BASE']).optional(),
  aspectRatio: z.enum(['1:1', '4:5']).optional().default('1:1'),
  style: shortText.optional(),
})

export const backgroundPromptSchema = z.object({
  productName: z.string().trim().min(1, 'Product name is required.').max(120),
  notes: z.array(z.string().trim().max(80)).max(30).optional().default([]),
  placement: z.enum(['CENTER', 'LEFT', 'RIGHT']).optional().default('CENTER'),
  mood: shortText.optional(),
  colors: shortText.optional(),
  lighting: shortText.optional(),
  environment: shortText.optional(),
  surface: shortText.optional(),
  aspectRatio: z.enum(['1:1', '4:5', '3:4', '16:9', '9:16']).optional().default('4:5'),
})
