import { Router } from 'express'
import { create } from '../controllers/orderController.js'
import { track, confirmation } from '../controllers/checkoutController.js'
import { orderLimiter } from '../middleware/rateLimitMiddleware.js'

const router = Router()

/** @deprecated — use /api/checkout/create-payment-order */
router.post('/', orderLimiter, create)

router.get('/track/:token', track)
router.get('/confirmation/:orderNumber', confirmation)

export default router
