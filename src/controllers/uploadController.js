import fs from 'fs/promises'
import { asyncHandler } from '../utils/asyncHandler.js'
import {
  isCloudinaryReady,
  uploadProductImage,
  uploadProductVideo,
} from '../services/imageService.js'
import { ApiError } from '../utils/ApiError.js'

export const uploadVideo = asyncHandler(async (req, res) => {
  try {
    const video = await uploadProductVideo(req.file, { slug: req.body?.slug || 'product' })
    res.status(201).json({ success: true, data: { video } })
  } finally {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {})
  }
})

export const uploadImage = asyncHandler(async (req, res) => {
  if (!isCloudinaryReady()) {
    throw new ApiError(
      501,
      'CLOUDINARY_UNAVAILABLE',
      'Cloudinary is not configured on the server.',
    )
  }

  const role = req.body?.role === 'gallery' ? 'gallery' : 'primary'
  const slug = req.body?.slug || 'product'
  const asset = await uploadProductImage(req.file, { slug, role })

  res.status(201).json({
    success: true,
    data: {
      image: asset,
    },
  })
})

export const uploadStatus = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: {
      cloudinaryConfigured: isCloudinaryReady(),
      folder: 'scentinova/products',
      allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxBytes: 5 * 1024 * 1024,
      video: {
        allowedTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
        maxBytes: 100 * 1024 * 1024,
      },
    },
  })
})
