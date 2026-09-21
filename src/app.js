import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import cookieParser from 'cookie-parser'
import { env, razorpayConfigured } from './config/env.js'
import { generalLimiter } from './middleware/rateLimitMiddleware.js'
import { errorMiddleware } from './middleware/errorMiddleware.js'
import { notFoundMiddleware } from './middleware/notFoundMiddleware.js'
import authRoutes from './routes/authRoutes.js'
import productRoutes from './routes/productRoutes.js'
import orderRoutes from './routes/orderRoutes.js'
import analyticsRoutes from './routes/analyticsRoutes.js'
import newsletterRoutes from './routes/newsletterRoutes.js'
import adminRoutes from './routes/adminRoutes.js'
import checkoutRoutes from './routes/checkoutRoutes.js'
import paymentRoutes from './routes/paymentRoutes.js'
import webhookRoutes from './routes/webhookRoutes.js'

export function createApp() {
  const app = express()

  app.set('trust proxy', 1)

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  )

  const allowedOrigins = new Set(
    [
      ...String(env.clientUrl)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      'http://localhost:5178',
      'http://localhost:5173',
      'http://127.0.0.1:5178',
      'http://127.0.0.1:5173',
    ].filter(Boolean),
  )

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true)
          return
        }
        // Do not throw — throwing becomes a 500 and hides CORS as INTERNAL_ERROR
        callback(null, false)
      },
      credentials: true,
    }),
  )

  app.use(morgan(env.isProd ? 'combined' : 'dev'))

  // Razorpay webhooks need the raw body for HMAC verification
  app.use(
    '/api/webhooks/razorpay',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      req.rawBody = req.body
      if (Buffer.isBuffer(req.body)) {
        try {
          req.body = JSON.parse(req.body.toString('utf8'))
        } catch {
          req.body = {}
        }
      }
      next()
    },
  )

  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use(cookieParser())
  app.use('/api', generalLimiter)

  app.get('/api/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        service: 'scentinova-api',
        database: 'connected',
        razorpay: razorpayConfigured(),
      },
    })
  })

  app.use('/api/auth', authRoutes)
  app.use('/api/products', productRoutes)
  app.use('/api/checkout', checkoutRoutes)
  app.use('/api/payments', paymentRoutes)
  app.use('/api/webhooks', webhookRoutes)
  app.use('/api/orders', orderRoutes)
  app.use('/api/analytics', analyticsRoutes)
  app.use('/api/newsletter', newsletterRoutes)
  app.use('/api/admin', adminRoutes)

  app.use(notFoundMiddleware)
  app.use(errorMiddleware)

  return app
}
