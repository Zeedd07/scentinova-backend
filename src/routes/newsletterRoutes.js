import { Router } from 'express'
import { subscribe } from '../controllers/newsletterController.js'
import { validate } from '../middleware/validateMiddleware.js'
import { newsletterSchema } from '../validators/newsletterValidators.js'

const router = Router()

router.post('/subscribe', validate(newsletterSchema), subscribe)

export default router
