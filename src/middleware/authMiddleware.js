import { ApiError } from '../utils/ApiError.js'
import { verifyAccessToken } from '../utils/jwt.js'
import { Admin } from '../models/Admin.js'
import { asyncHandler } from '../utils/asyncHandler.js'

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || ''
  const [type, token] = header.split(' ')
  if (type !== 'Bearer' || !token) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required.')
  }

  let payload
  try {
    payload = verifyAccessToken(token)
  } catch {
    throw new ApiError(401, 'TOKEN_INVALID', 'Your admin session has expired. Please sign in again.')
  }

  const admin = await Admin.findById(payload.sub)
  if (!admin || !admin.active) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required.')
  }

  req.admin = admin
  next()
})

export const requireAdmin = asyncHandler(async (req, _res, next) => {
  if (!req.admin || req.admin.role !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN', 'Admin access required.')
  }
  next()
})
