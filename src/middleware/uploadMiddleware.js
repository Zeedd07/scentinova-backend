import os from 'os'
import multer from 'multer'
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, VIDEO_MIME } from '../services/imageService.js'
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

/** Videos go to a temp file (not memory); the controller deletes it after upload. */
export const uploadProductVideoMiddleware = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!VIDEO_MIME.has(file.mimetype)) {
      cb(
        new ApiError(400, 'INVALID_FILE', 'Only MP4, MOV and WebM videos are allowed.', {
          file: 'Unsupported file type.',
        }),
      )
      return
    }
    cb(null, true)
  },
}).single('video')

export function handleMulterError(err, req, _res, next) {
  if (!err) return next()
  if (err instanceof ApiError) return next(err)
  if (err.code === 'LIMIT_FILE_SIZE') {
    const isVideo = req.originalUrl?.includes('/uploads/video')
    return next(
      new ApiError(
        400,
        'INVALID_FILE',
        isVideo ? 'Video must be 100 MB or smaller.' : 'Image must be 5 MB or smaller.',
        { file: 'File too large.' },
      ),
    )
  }
  if (err.name === 'MulterError') {
    return next(new ApiError(400, 'INVALID_FILE', err.message || 'Invalid upload.'))
  }
  return next(err)
}
