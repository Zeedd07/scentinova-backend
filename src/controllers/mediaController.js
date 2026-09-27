import { asyncHandler } from '../utils/asyncHandler.js'
import { ApiError } from '../utils/ApiError.js'
import * as mediaService from '../services/mediaService.js'
import { mediaListQuerySchema, mediaUploadSchema } from '../validators/mediaValidators.js'

function actor(req) {
  return { adminId: req.admin?._id ?? null, ip: req.ip ?? null }
}

export const list = asyncHandler(async (req, res) => {
  const result = await mediaService.listAssets(mediaListQuerySchema.parse(req.query))
  res.json({ success: true, data: { assets: result.assets }, meta: result.meta })
})

export const noteDefaults = asyncHandler(async (req, res) => {
  const defaults = await mediaService.getNoteDefaults(String(req.query.keys || '').slice(0, 4000))
  res.json({ success: true, data: { defaults } })
})

export const get = asyncHandler(async (req, res) => {
  const result = await mediaService.getAsset(req.params.id)
  res.json({ success: true, data: result })
})

export const upload = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Please choose an image file.', {
      file: 'Image file is required.',
    })
  }
  const input = mediaUploadSchema.parse(req.body || {})
  const asset = await mediaService.uploadAsset(req.file, input, actor(req))
  res.status(201).json({ success: true, data: { asset } })
})

export const update = asyncHandler(async (req, res) => {
  const asset = await mediaService.updateAsset(req.params.id, req.body, actor(req))
  res.json({ success: true, data: { asset } })
})

export const remove = asyncHandler(async (req, res) => {
  const result = await mediaService.deleteAsset(req.params.id, actor(req))
  res.json({ success: true, data: result })
})
