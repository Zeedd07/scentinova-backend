import { createApp } from './app.js'
import { connectDb, disconnectDb } from './config/db.js'
import { configureCloudinary, isCloudinaryReady } from './config/cloudinary.js'
import { env, razorpayConfigured } from './config/env.js'
import { startBackgroundJobs } from './jobs/expireOrders.js'

async function start() {
  await connectDb()
  configureCloudinary()
  const app = createApp()
  const jobTimer = startBackgroundJobs()

  const server = app.listen(env.port, () => {
    console.log(`[Scentinova API] Running on port ${env.port}`)
    console.log(
      `[Cloudinary] ${isCloudinaryReady() ? 'Configured' : 'Not configured — URL/path images only'}`,
    )
    console.log(
      `[Razorpay] ${razorpayConfigured() ? 'Configured' : 'Not configured — set RAZORPAY_KEY_ID/SECRET'}`,
    )
  })

  const shutdown = async (signal) => {
    console.log(`[Scentinova API] ${signal} received — shutting down`)
    clearInterval(jobTimer)
    server.close(async () => {
      await disconnectDb()
      process.exit(0)
    })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

start().catch((err) => {
  console.error('Failed to start Scentinova API')
  console.error(err)
  process.exit(1)
})
