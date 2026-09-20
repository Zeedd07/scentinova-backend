import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

function required(key, fallback) {
  const value = process.env[key] ?? fallback
  if (value === undefined || value === '') {
    throw new Error(`Missing required env: ${key}`)
  }
  return value
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  mongodbUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/scentinova'),
  clientUrl: required('CLIENT_URL', 'http://localhost:5173'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
  jwtRefreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@scentinova.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'ChangeThisImmediately',
  cookieSecure: String(process.env.COOKIE_SECURE).toLowerCase() === 'true',
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 100),
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  email: {
    provider: process.env.EMAIL_PROVIDER || '',
    from: process.env.EMAIL_FROM || '',
    apiKey: process.env.EMAIL_API_KEY || '',
  },
  orderPaymentTtlMinutes: Number(process.env.ORDER_PAYMENT_TTL_MINUTES || 30),
  /** Free shipping threshold in paise (default ₹2500). */
  freeShippingThresholdPaise: Number(process.env.FREE_SHIPPING_THRESHOLD_PAISE || 250000),
  /** Flat shipping in paise when under threshold (default ₹99). */
  shippingPaise: Number(process.env.SHIPPING_PAISE || 9900),
  isProd: (process.env.NODE_ENV || 'development') === 'production',
}

export function cloudinaryConfigured() {
  const { cloudName, apiKey, apiSecret } = env.cloudinary
  return Boolean(cloudName && apiKey && apiSecret)
}

export function razorpayConfigured() {
  const { keyId, keySecret } = env.razorpay
  return Boolean(keyId && keySecret)
}
