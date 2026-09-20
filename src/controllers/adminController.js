import { asyncHandler } from '../utils/asyncHandler.js'
import * as analyticsService from '../services/analyticsService.js'

export const dashboard = asyncHandler(async (_req, res) => {
  const data = await analyticsService.getOverview()
  res.json({ success: true, data })
})
