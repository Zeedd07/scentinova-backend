import { asyncHandler } from '../utils/asyncHandler.js'
import * as paymentService from '../services/paymentService.js'

export const verify = asyncHandler(async (req, res) => {
  const data = await paymentService.verifyCheckoutPayment(req.body)
  res.json({ success: true, data })
})

export const failed = asyncHandler(async (req, res) => {
  const order = await paymentService.markPaymentFailed(req.body)
  res.json({ success: true, data: { order } })
})

export const webhook = asyncHandler(async (req, res) => {
  const signature = req.get('x-razorpay-signature')
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body))
  const result = await paymentService.processRazorpayWebhook(rawBody, signature)
  res.json({ success: true, data: result })
})
