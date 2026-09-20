import { asyncHandler } from '../utils/asyncHandler.js'
import * as orderService from '../services/orderService.js'

export const create = asyncHandler(async (req, res) => {
  // Legacy endpoint — prepaid checkout required
  await orderService.createOrder(req.body)
  res.status(410).json({ success: false })
})

export const adminList = asyncHandler(async (req, res) => {
  const data = await orderService.listAdminOrders(req.query)
  res.json({ success: true, data })
})

export const adminGet = asyncHandler(async (req, res) => {
  const order = await orderService.getAdminOrder(req.params.id)
  res.json({ success: true, data: { order } })
})

export const adminUpdateStatus = asyncHandler(async (req, res) => {
  const order = await orderService.updateOrderStatus(req.params.id, req.body.status, {
    admin: req.admin,
    note: req.body.note,
    shipping: req.body.shipping,
  })
  res.json({ success: true, data: { order } })
})

export const adminUpdateShipping = asyncHandler(async (req, res) => {
  const order = await orderService.updateShipping(req.params.id, req.body, {
    admin: req.admin,
  })
  res.json({ success: true, data: { order } })
})

export const adminRefund = asyncHandler(async (req, res) => {
  const order = await orderService.refundOrder(req.params.id, {
    amountPaise: req.body.amountPaise,
    reason: req.body.reason,
    admin: req.admin,
  })
  res.json({ success: true, data: { order } })
})
