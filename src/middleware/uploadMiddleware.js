import multer from 'multer'
import { MAX_UPLOAD_BYTES } from '../services/imageService.js'
import { ApiError } from '../utils/ApiError.js'

const storage = multer.memoryStorage()

function fileFilter(_req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp']
  if (!allowed.includes(file.mimetype)) {
    cb(
      new ApiError(400, 'INVALID_FILE', 'Only JPEG, PNG, and WebP images are allowed.', {
        file: 'Unsupported file type.',
      }),
    )
    return
  }
  cb(null, true)
}

export const uploadProductImageMiddleware = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter,
}).single('image')

export function handleMulterError(err, _req, _res, next) {
  if (!err) return next()
  if (err instanceof ApiError) return next(err)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return next(
      new ApiError(400, 'INVALID_FILE', 'Image must be 5 MB or smaller.', {
        file: 'File too large.',
      }),
    )
  }
  if (err.name === 'MulterError') {
    return next(new ApiError(400, 'INVALID_FILE', err.message || 'Invalid upload.'))
  }
  return next(err)
}
