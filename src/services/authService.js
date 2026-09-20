import bcrypt from 'bcryptjs'
import { Admin } from '../models/Admin.js'
import { ApiError } from '../utils/ApiError.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt.js'
import { env } from '../config/env.js'

function safeUser(admin) {
  return {
    id: admin._id.toString(),
    name: admin.name,
    email: admin.email,
    role: admin.role,
  }
}

export async function loginAdmin(email, password) {
  const admin = await Admin.findOne({ email: email.toLowerCase() }).select('+passwordHash')
  if (!admin || !admin.active) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.')
  }

  const ok = await bcrypt.compare(password, admin.passwordHash)
  if (!ok) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.')
  }

  admin.lastLoginAt = new Date()
  await admin.save()

  const payload = { sub: admin._id.toString(), email: admin.email, role: admin.role }
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    user: safeUser(admin),
  }
}

export async function refreshAdminSession(refreshToken) {
  if (!refreshToken) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required.')
  }

  let payload
  try {
    payload = verifyRefreshToken(refreshToken)
  } catch {
    throw new ApiError(401, 'TOKEN_INVALID', 'Your admin session has expired. Please sign in again.')
  }

  const admin = await Admin.findById(payload.sub)
  if (!admin || !admin.active) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required.')
  }

  const nextPayload = { sub: admin._id.toString(), email: admin.email, role: admin.role }
  return {
    accessToken: signAccessToken(nextPayload),
    user: safeUser(admin),
  }
}

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }
}

export const REFRESH_COOKIE = 'scentinova_refresh'
