import { Router } from 'express'
import {
  listProducts,
  listFeatured,
  getBySlug,
} from '../controllers/productController.js'

const router = Router()

router.get('/', listProducts)
router.get('/featured', listFeatured)
router.get('/:slug', getBySlug)

export default router
