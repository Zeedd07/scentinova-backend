import { Router } from 'express'
import { login, refresh, logout, me } from '../controllers/authController.js'
import { validate } from '../middleware/validateMiddleware.js'
import { loginSchema } from '../validators/authValidators.js'
import { authLimiter } from '../middleware/rateLimitMiddleware.js'
import { requireAuth, requireAdmin } from '../middleware/authMiddleware.js'

const router = Router()

router.post('/login', authLimiter, validate(loginSchema), login)
router.post('/refresh', refresh)
router.post('/logout', logout)
router.get('/me', requireAuth, requireAdmin, me)

export default router
