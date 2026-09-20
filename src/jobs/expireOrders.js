import { connectDb, disconnectDb } from '../config/db.js'
import { expireStaleReservations } from '../services/inventoryService.js'
import { expireUnpaidOrders } from '../services/paymentService.js'
import { logger } from '../utils/logger.js'

const INTERVAL_MS = Number(process.env.JOB_INTERVAL_MS || 60_000)

export function startBackgroundJobs() {
  const tick = async () => {
    try {
      const reservations = await expireStaleReservations()
      const orders = await expireUnpaidOrders()
      if (reservations.expired || orders.expiredOrders) {
        logger.info('expiry job', { ...reservations, ...orders })
      }
    } catch (err) {
      logger.error('expiry job failed', { message: err.message })
    }
  }

  tick()
  return setInterval(tick, INTERVAL_MS)
}
