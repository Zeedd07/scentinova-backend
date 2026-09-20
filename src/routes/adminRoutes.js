import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/authMiddleware.js'
import { dashboard } from '../controllers/adminController.js'
import {
  adminList as listProducts,
  adminGet as getProduct,
  adminCreate as createProduct,
  adminUpdate as updateProduct,
  adminDelete as deleteProduct,
} from '../controllers/productController.js'
import {
  adminList as listOrders,
  adminGet as getOrder,
  adminUpdateStatus as updateOrderStatus,
  adminUpdateShipping as updateShipping,
  adminRefund as refundOrder,
} from '../controllers/orderController.js'
import {
  overview as analyticsOverview,
  products as analyticsProducts,
} from '../controllers/analyticsController.js'
import { adminList as listNewsletter } from '../controllers/newsletterController.js'
import { uploadImage, uploadStatus } from '../controllers/uploadController.js'
import {
  handleMulterError,
  uploadProductImageMiddleware,
} from '../middleware/uploadMiddleware.js'
import { validate } from '../middleware/validateMiddleware.js'
import {
  productCreateSchema,
  productUpdateSchema,
} from '../validators/productValidators.js'
import {
  adminOrderStatusSchema,
  adminShippingSchema,
  adminRefundSchema,
} from '../validators/checkoutValidators.js'

const router = Router()

router.use(requireAuth, requireAdmin)

router.get('/dashboard', dashboard)

router.get('/uploads/status', uploadStatus)
router.post(
  '/uploads/image',
  (req, res, next) => {
    uploadProductImageMiddleware(req, res, (err) => {
      if (err) return handleMulterError(err, req, res, next)
      next()
    })
  },
  uploadImage,
)

router.get('/products', listProducts)
router.get('/products/:id', getProduct)
router.post('/products', validate(productCreateSchema), createProduct)
router.patch('/products/:id', validate(productUpdateSchema), updateProduct)
router.delete('/products/:id', deleteProduct)

router.get('/orders', listOrders)
router.get('/orders/:id', getOrder)
router.patch('/orders/:id/status', validate(adminOrderStatusSchema), updateOrderStatus)
router.patch('/orders/:id/shipping', validate(adminShippingSchema), updateShipping)
router.post('/orders/:id/refund', validate(adminRefundSchema), refundOrder)

router.get('/analytics/overview', analyticsOverview)
router.get('/analytics/products', analyticsProducts)

router.get('/newsletter', listNewsletter)

export default router
