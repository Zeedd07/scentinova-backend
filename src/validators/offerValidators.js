import { z } from 'zod'
import { MAX_OFFERS, OFFER_TEXT_MAX } from '../models/Offer.js'

const offerText = z
  .string()
  .trim()
  .min(1, 'Offer text is required.')
  .max(OFFER_TEXT_MAX, `Keep the offer under ${OFFER_TEXT_MAX} characters.`)

export const offerCreateSchema = z
  .object({
    text: offerText,
    active: z.boolean().optional(),
  })
  .strict()

export const offerUpdateSchema = z
  .object({
    text: offerText.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.text !== undefined || v.active !== undefined, {
    message: 'Nothing to update.',
  })

export const offerReorderSchema = z
  .object({
    ids: z.array(z.string().trim().min(1)).min(1).max(MAX_OFFERS),
  })
  .strict()
