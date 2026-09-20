import { Router } from 'express'
import { trackEvent } from '../controllers/analyticsController.js'
import { validate } from '../middleware/validateMiddleware.js'
import { analyticsEventSchema } from '../validators/newsletterValidators.js'
import { analyticsLimiter } from '../middleware/rateLimitMiddleware.js'

const router = Router()

router.post('/events', analyticsLimiter, validate(analyticsEventSchema), trackEvent)

export default router
