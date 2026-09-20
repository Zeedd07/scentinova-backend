import { Router } from 'express'
import { webhook } from '../controllers/paymentController.js'

const router = Router()

router.post('/razorpay', webhook)

export default router
