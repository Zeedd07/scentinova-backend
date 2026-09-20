import { ApiError } from '../utils/ApiError.js'
import { env } from '../config/env.js'

export function notFoundMiddleware(_req, _res, next) {
  next(new ApiError(404, 'NOT_FOUND', 'Route not found.'))
}

export function errorMiddleware(err, _req, res, _next) {
  let status = err.statusCode || 500
  let code = err.code || 'INTERNAL_ERROR'
  let message = err.message || 'Something went wrong.'
  let fields = err.fields || null

  if (err.name === 'ZodError') {
    status = 400
    code = 'VALIDATION_ERROR'
    message = 'Please correct the highlighted fields.'
    fields = {}
    for (const issue of err.issues || []) {
      const key = issue.path?.join('.') || 'form'
      fields[key] = issue.message
    }
  }

  if (err.name === 'ValidationError' && err.errors) {
    status = 400
    code = 'VALIDATION_ERROR'
    message = 'Please correct the highlighted fields.'
    fields = {}
    for (const [key, value] of Object.entries(err.errors)) {
      fields[key] = value.message
    }
  }

  if (err.code === 11000) {
    status = 409
    code = 'DUPLICATE'
    message = 'A record with that value already exists.'
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    status = 401
    code = 'TOKEN_INVALID'
    message = 'Your admin session has expired. Please sign in again.'
  }

  if (err.type === 'entity.parse.failed') {
    status = 400
    code = 'INVALID_JSON'
    message = 'Malformed JSON body.'
  }

  const payload = {
    success: false,
    error: {
      code,
      message: env.isProd && status === 500 ? 'Something went wrong.' : message,
      ...(fields ? { fields } : {}),
    },
  }

  if (!env.isProd && status === 500) {
    payload.error.stack = err.stack
  }

  res.status(status).json(payload)
}
