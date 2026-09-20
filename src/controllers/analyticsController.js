import { asyncHandler } from '../utils/asyncHandler.js'
import * as analyticsService from '../services/analyticsService.js'

export const trackEvent = asyncHandler(async (req, res) => {
  const result = await analyticsService.recordEvent(req.body)
  res.status(201).json({ success: true, data: result })
})

export const overview = asyncHandler(async (_req, res) => {
  const data = await analyticsService.getOverview()
  res.json({ success: true, data })
})

export const products = asyncHandler(async (_req, res) => {
  const data = await analyticsService.getProductAnalytics()
  res.json({ success: true, data })
})
