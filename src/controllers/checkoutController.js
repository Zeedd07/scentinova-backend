import { asyncHandler } from '../utils/asyncHandler.js'
import * as checkoutService from '../services/checkoutService.js'

export const quote = asyncHandler(async (req, res) => {
  const data = await checkoutService.quoteCart(req.body)
  res.json({ success: true, data })
})

export const createPaymentOrder = asyncHandler(async (req, res) => {
  const idempotencyKey =
    req.get('Idempotency-Key') || req.body.idempotencyKey || null
  const data = await checkoutService.createPaymentOrder(req.body, {
    idempotencyKey,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.status(201).json({ success: true, data })
})

export const track = asyncHandler(async (req, res) => {
  const order = await checkoutService.trackOrderByToken(req.params.token)
  res.json({ success: true, data: { order } })
})

export const confirmation = asyncHandler(async (req, res) => {
  const order = await checkoutService.getOrderForConfirmation(req.params.orderNumber, {
    trackingToken: req.query.token,
  })
  res.json({ success: true, data: { order } })
})
