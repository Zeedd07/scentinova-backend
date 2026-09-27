import { Router } from 'express'
import { create } from '../controllers/orderController.js'
import {
  track,
  trackByToken,
  confirmation,
} from '../controllers/checkoutController.js'
import { orderLimiter, trackLimiter } from '../middleware/rateLimitMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import { trackOrderSchema } from '../validators/orderValidators.js'

const router = Router()

/** @deprecated — use /api/checkout/create-payment-order */
router.post('/', orderLimiter, create)

// Secret travels in the body so it never lands in URL/access logs
router.post('/track', trackLimiter, validate(trackOrderSchema), track)
/** @deprecated — legacy token-only links; same sanitized payload as POST /track */
router.get('/track/:token', trackLimiter, trackByToken)
router.get('/confirmation/:orderNumber', trackLimiter, confirmation)

export default router
