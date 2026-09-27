import { asyncHandler } from '../utils/asyncHandler.js'
import * as checkoutService from '../services/checkoutService.js'
import {
  trackPublicOrder,
  trackPublicOrderByToken,
} from '../services/orderTrackingService.js'

export const options = asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({ success: true, data: checkoutService.getCheckoutOptions() })
})

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
  const order = await trackPublicOrder(req.body)
  res.set('Cache-Control', 'no-store')
  res.json({ success: true, data: { order } })
})

export const trackByToken = asyncHandler(async (req, res) => {
  const order = await trackPublicOrderByToken(req.params.token)
  res.set('Cache-Control', 'no-store')
  res.json({ success: true, data: { order } })
})

export const confirmation = asyncHandler(async (req, res) => {
  const order = await checkoutService.getOrderForConfirmation(req.params.orderNumber, {
    trackingToken: req.query.token,
  })
  res.json({ success: true, data: { order } })
})
