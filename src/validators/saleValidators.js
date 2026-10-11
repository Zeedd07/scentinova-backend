import { z } from 'zod'
import mongoose from 'mongoose'
import {
  SALE_NAME_MAX,
  SALE_PERCENT_MAX,
  SALE_PERCENT_MIN,
  SALE_SCOPES,
} from '../models/Sale.js'

const name = z
  .string()
  .trim()
  .min(1, 'Sale name is required.')
  .max(SALE_NAME_MAX, `Keep the sale name under ${SALE_NAME_MAX} characters.`)

const percentOff = z
  .number()
  .int('Percent off must be a whole number.')
  .min(SALE_PERCENT_MIN, `Percent off must be at least ${SALE_PERCENT_MIN}%.`)
  .max(SALE_PERCENT_MAX, `Percent off can be at most ${SALE_PERCENT_MAX}%.`)

const productIds = z
  .array(
    z.string().trim().refine((id) => mongoose.isValidObjectId(id), 'Invalid product.'),
  )
  .max(200)

const date = z
  .string()
  .datetime({ offset: true, message: 'Use a valid date and time.' })
  .nullable()

const fields = {
  name,
  percentOff,
  appliesTo: z.enum(SALE_SCOPES),
  productIds,
  active: z.boolean(),
  startsAt: date,
  endsAt: date,
}

export const saleCreateSchema = z
  .object({
    ...fields,
    appliesTo: fields.appliesTo.default('ALL'),
    productIds: fields.productIds.default([]),
    active: fields.active.optional(),
    startsAt: fields.startsAt.optional(),
    endsAt: fields.endsAt.optional(),
  })
  .strict()

export const saleUpdateSchema = z
  .object({
    name: fields.name.optional(),
    percentOff: fields.percentOff.optional(),
    appliesTo: fields.appliesTo.optional(),
    productIds: fields.productIds.optional(),
    active: fields.active.optional(),
    startsAt: fields.startsAt.optional(),
    endsAt: fields.endsAt.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' })
