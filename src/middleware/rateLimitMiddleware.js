import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'

/** Health checks and analytics beacons (which has its own limiter) don't use up the shared budget. */
const UNCOUNTED_PATHS = ['/health', '/analytics/']

export const generalLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  max: env.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => UNCOUNTED_PATHS.some((p) => req.path === p || req.path.startsWith(p)),
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
  },
})

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again later.' },
  },
})

export const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many orders. Please try again later.' },
  },
})

/** Guest order lookups — only failed attempts count, so refreshes never lock a customer out. */
export const trackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many tracking attempts. Please wait a few minutes and try again.',
    },
  },
})

export const analyticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many analytics events.' },
  },
})
