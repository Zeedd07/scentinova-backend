import { asyncHandler } from '../utils/asyncHandler.js'
import {
  loginAdmin,
  refreshAdminSession,
  refreshCookieOptions,
  REFRESH_COOKIE,
} from '../services/authService.js'
import { Admin } from '../models/Admin.js'
import { ApiError } from '../utils/ApiError.js'

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body
  const result = await loginAdmin(email, password)
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions())
  res.json({
    success: true,
    data: {
      accessToken: result.accessToken,
      user: result.user,
    },
  })
})

export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE]
  const result = await refreshAdminSession(token)
  res.json({
    success: true,
    data: {
      accessToken: result.accessToken,
      user: result.user,
    },
  })
})

export const logout = asyncHandler(async (_req, res) => {
  const cookieOpts = refreshCookieOptions()
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: cookieOpts.httpOnly,
    sameSite: cookieOpts.sameSite,
    secure: cookieOpts.secure,
    path: cookieOpts.path,
  })
  res.json({ success: true, data: { loggedOut: true } })
})

export const me = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.admin._id)
  if (!admin || !admin.active) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required.')
  }
  res.json({
    success: true,
    data: {
      user: {
        id: admin._id.toString(),
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    },
  })
})
