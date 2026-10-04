import { asyncHandler } from '../utils/asyncHandler.js'
import * as offerService from '../services/offerService.js'

function actor(req) {
  return { adminId: req.admin?._id ?? null, ip: req.ip ?? null }
}

export const publicList = asyncHandler(async (_req, res) => {
  const offers = await offerService.listActiveOffers()
  res.json({ success: true, data: { offers } })
})

export const adminList = asyncHandler(async (_req, res) => {
  const offers = await offerService.listAllOffers()
  res.json({ success: true, data: { offers } })
})

export const adminCreate = asyncHandler(async (req, res) => {
  const offer = await offerService.createOffer(req.body, actor(req))
  res.status(201).json({ success: true, data: { offer } })
})

export const adminUpdate = asyncHandler(async (req, res) => {
  const offer = await offerService.updateOffer(req.params.id, req.body, actor(req))
  res.json({ success: true, data: { offer } })
})

export const adminDelete = asyncHandler(async (req, res) => {
  const result = await offerService.deleteOffer(req.params.id, actor(req))
  res.json({ success: true, data: result })
})

export const adminReorder = asyncHandler(async (req, res) => {
  const offers = await offerService.reorderOffers(req.body.ids, actor(req))
  res.json({ success: true, data: { offers } })
})
