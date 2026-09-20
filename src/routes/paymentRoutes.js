import { Router } from 'express'
import { verify, failed } from '../controllers/paymentController.js'
import { validate } from '../middleware/validateMiddleware.js'
import {
  paymentVerifySchema,
  paymentFailedSchema,
} from '../validators/checkoutValidators.js'
import { orderLimiter } from '../middleware/rateLimitMiddleware.js'

const router = Router()

router.post('/verify', orderLimiter, validate(paymentVerifySchema), verify)
router.post('/failed', orderLimiter, validate(paymentFailedSchema), failed)

export default router
