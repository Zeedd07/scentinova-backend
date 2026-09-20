import { Router } from 'express'
import { quote, createPaymentOrder } from '../controllers/checkoutController.js'
import { validate } from '../middleware/validateMiddleware.js'
import {
  checkoutQuoteSchema,
  checkoutCreateSchema,
} from '../validators/checkoutValidators.js'
import { orderLimiter } from '../middleware/rateLimitMiddleware.js'

const router = Router()

router.post('/quote', orderLimiter, validate(checkoutQuoteSchema), quote)
router.post(
  '/create-payment-order',
  orderLimiter,
  validate(checkoutCreateSchema),
  createPaymentOrder,
)

export default router
