import { Router } from 'express'
import { publicList } from '../controllers/offerController.js'

const router = Router()

router.get('/', publicList)

export default router
