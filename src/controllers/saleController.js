import { asyncHandler } from '../utils/asyncHandler.js'
import * as saleService from '../services/saleService.js'

function actor(req) {
  return { adminId: req.admin?._id ?? null, ip: req.ip ?? null }
}

export const adminList = asyncHandler(async (_req, res) => {
  const sales = await saleService.listAllSales()
  res.json({ success: true, data: { sales } })
})

export const adminCreate = asyncHandler(async (req, res) => {
  const sale = await saleService.createSale(req.body, actor(req))
  res.status(201).json({ success: true, data: { sale } })
})

export const adminUpdate = asyncHandler(async (req, res) => {
  const sale = await saleService.updateSale(req.params.id, req.body, actor(req))
  res.json({ success: true, data: { sale } })
})

export const adminDelete = asyncHandler(async (req, res) => {
  const result = await saleService.deleteSale(req.params.id, actor(req))
  res.json({ success: true, data: result })
})
