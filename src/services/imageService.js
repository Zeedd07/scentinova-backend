/**
 * Image upload / delivery helpers — Cloudinary only lives here.
 */
import { Readable } from 'stream'
import {
  CLOUDINARY_PRODUCT_FOLDER,
  getCloudinary,
  isCloudinaryReady,
} from '../config/cloudinary.js'
import { ApiError } from '../utils/ApiError.js'
import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { MediaAsset } from '../models/MediaAsset.js'

export { isCloudinaryReady }

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB

export function assertValidImageFile(file) {
  if (!file) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Please choose an image file.', {
      file: 'Image file is required.',
    })
  }
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new ApiError(400, 'INVALID_FILE', 'Only JPEG, PNG, and WebP images are allowed.', {
      file: 'Unsupported file type.',
    })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(400, 'INVALID_FILE', 'Image must be 5 MB or smaller.', {
      file: 'File too large.',
    })
  }
}

function sanitizePublicIdPart(value) {
  return String(value || 'asset')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || 'asset'
}

/**
 * Delivery URL with non-destructive web optimizations.
 * Original asset on Cloudinary is unchanged.
 */
export function buildDeliveryUrl(publicId, { width } = {}) {
  const cld = getCloudinary()
  return cld.url(publicId, {
    secure: true,
    transformation: [
      {
        quality: 'auto',
        fetch_format: 'auto',
        ...(width ? { width, crop: 'limit' } : {}),
      },
    ],
  })
}

/** Cropped, optimized delivery URL (e.g. 1:1 note thumbnails). */
export function buildCroppedUrl(publicId, { width = 320, aspectRatio = '1:1' } = {}) {
  const cld = getCloudinary()
  return cld.url(publicId, {
    secure: true,
    transformation: [
      {
        crop: 'fill',
        gravity: 'auto',
        aspect_ratio: aspectRatio,
        width,
        quality: 'auto',
        fetch_format: 'auto',
      },
    ],
  })
}

/** Original-quality URL that makes the browser download straight from Cloudinary. */
export function buildAttachmentUrl(publicId, filename) {
  const cld = getCloudinary()
  const name = sanitizePublicIdPart(filename || publicId.split('/').pop())
  return cld.url(publicId, {
    secure: true,
    flags: `attachment:${name}`,
  })
}

function mapUploadResult(result) {
  const deliveryUrl = buildDeliveryUrl(result.public_id)
  return {
    secure_url: result.secure_url,
    delivery_url: deliveryUrl,
    public_id: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
    // Convenience for product forms / MongoDB
    url: deliveryUrl || result.secure_url,
  }
}

function uploadBuffer(buffer, options) {
  const cld = getCloudinary()
  return new Promise((resolve, reject) => {
    const stream = cld.uploader.upload_stream(options, (err, result) => {
      if (err) {
        reject(
          new ApiError(
            502,
            'CLOUDINARY_UNAVAILABLE',
            err.message || 'Cloudinary upload failed. Please try again.',
          ),
        )
        return
      }
      resolve(result)
    })
    Readable.from(buffer).pipe(stream)
  })
}

/**
 * Upload a Multer memory file to scentinova/products.
 */
export async function uploadProductImage(file, { slug, role = 'primary' } = {}) {
  assertValidImageFile(file)
  if (!isCloudinaryReady()) {
    throw new ApiError(
      501,
      'CLOUDINARY_UNAVAILABLE',
      'Cloudinary is not configured on the server.',
    )
  }

  const stamp = Date.now().toString(36)
  const base = sanitizePublicIdPart(slug)
  const rolePart = role === 'gallery' ? `gallery-${stamp}` : `hero-${stamp}`
  const publicId = `${CLOUDINARY_PRODUCT_FOLDER}/${base}/${rolePart}`

  try {
    const result = await uploadBuffer(file.buffer, {
      public_id: publicId,
      folder: undefined, // included in public_id
      resource_type: 'image',
      overwrite: false,
      unique_filename: false,
      use_filename: false,
    })
    return mapUploadResult(result)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(
      502,
      'UPLOAD_FAILED',
      err.message || 'Upload failed. Please try again.',
    )
  }
}

/**
 * Upload a validated Multer file to an exact public_id (no overwrite).
 * Caller is responsible for choosing a public_id that is not already taken.
 */
export async function uploadImageToPublicId(file, publicId, { tags = [] } = {}) {
  assertValidImageFile(file)
  if (!isCloudinaryReady()) {
    throw new ApiError(501, 'CLOUDINARY_UNAVAILABLE', 'Cloudinary is not configured on the server.')
  }
  try {
    const result = await uploadBuffer(file.buffer, {
      public_id: publicId,
      resource_type: 'image',
      overwrite: false,
      unique_filename: false,
      use_filename: false,
      ...(tags.length ? { tags } : {}),
    })
    if (result.existing) {
      throw new ApiError(409, 'DUPLICATE', 'An image with that name already exists on Cloudinary.')
    }
    return mapUploadResult(result)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(502, 'UPLOAD_FAILED', 'Upload failed. Please try again.')
  }
}

/** Destroy an asset; throws when Cloudinary does not confirm the deletion. */
export async function destroyCloudinaryAssetStrict(publicId) {
  if (!isCloudinaryReady()) {
    throw new ApiError(501, 'CLOUDINARY_UNAVAILABLE', 'Cloudinary is not configured on the server.')
  }
  let result
  try {
    result = await getCloudinary().uploader.destroy(publicId, { resource_type: 'image', invalidate: true })
  } catch {
    throw new ApiError(502, 'CLOUDINARY_DELETE_FAILED', 'Cloudinary could not delete this image. Please try again.')
  }
  if (result?.result !== 'ok' && result?.result !== 'not found') {
    throw new ApiError(502, 'CLOUDINARY_DELETE_FAILED', 'Cloudinary could not delete this image. Please try again.')
  }
  return { deleted: true, result: result.result }
}

export async function deleteCloudinaryAsset(publicId) {
  if (!publicId || !isCloudinaryReady()) return { deleted: false }
  try {
    const cld = getCloudinary()
    const result = await cld.uploader.destroy(publicId, { resource_type: 'image' })
    return { deleted: result.result === 'ok' || result.result === 'not found', result }
  } catch {
    return { deleted: false }
  }
}

/**
 * True if publicId is still used by a product or order snapshot.
 */
export async function isPublicIdReferenced(publicId, { excludeProductId } = {}) {
  if (!publicId) return false

  const productFilter = {
    $or: [{ imagePublicId: publicId }, { galleryPublicIds: publicId }],
  }
  if (excludeProductId) {
    productFilter._id = { $ne: excludeProductId }
  }

  const [inProduct, inOrder, inLibrary] = await Promise.all([
    Product.exists(productFilter),
    Order.exists({ 'items.image': { $regex: publicId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }),
    MediaAsset.exists({ publicId }),
  ])

  // Also match delivery/secure URLs that contain the public id path
  if (inProduct || inOrder || inLibrary) return true

  const urlHit = await Order.exists({
    'items.image': { $regex: publicId },
  })
  return Boolean(urlHit)
}

/**
 * Delete old Cloudinary asset only when nothing else references it.
 * Never auto-delete on product archive.
 */
export async function safeDeleteUnreferencedAsset(publicId, { excludeProductId } = {}) {
  if (!publicId) return { deleted: false, reason: 'empty' }
  const referenced = await isPublicIdReferenced(publicId, { excludeProductId })
  if (referenced) return { deleted: false, reason: 'referenced' }
  return deleteCloudinaryAsset(publicId)
}
