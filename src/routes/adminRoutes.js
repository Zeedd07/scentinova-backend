import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/authMiddleware.js'
import { dashboard } from '../controllers/adminController.js'
import {
  adminList as listProducts,
  adminGet as getProduct,
  adminCreate as createProduct,
  adminUpdate as updateProduct,
  adminDelete as deleteProduct,
  adminDeletePermanent as deleteProductPermanent,
} from '../controllers/productController.js'
import {
  adminList as listOrders,
  adminGet as getOrder,
  adminUpdateStatus as updateOrderStatus,
  adminAddUpdate as addOrderUpdate,
  adminUpdateShipping as updateShipping,
  adminRefund as refundOrder,
  adminMarkCodPaid as markCodPaid,
} from '../controllers/orderController.js'
import {
  overview as analyticsOverview,
  products as analyticsProducts,
} from '../controllers/analyticsController.js'
import { adminList as listNewsletter } from '../controllers/newsletterController.js'
import {
  adminList as listOffers,
  adminCreate as createOffer,
  adminUpdate as updateOffer,
  adminDelete as deleteOffer,
  adminReorder as reorderOffers,
} from '../controllers/offerController.js'
import {
  offerCreateSchema,
  offerReorderSchema,
  offerUpdateSchema,
} from '../validators/offerValidators.js'
import { uploadImage, uploadStatus, uploadVideo } from '../controllers/uploadController.js'
import {
  handleMulterError,
  uploadProductImageMiddleware,
  uploadProductVideoMiddleware,
} from '../middleware/uploadMiddleware.js'
import {
  list as listMedia,
  get as getMedia,
  upload as uploadMedia,
  update as updateMedia,
  remove as deleteMedia,
  noteDefaults as mediaNoteDefaults,
} from '../controllers/mediaController.js'
import { notePrompt, backgroundPrompt } from '../controllers/promptController.js'
import {
  backgroundPromptSchema,
  mediaUpdateSchema,
  notePromptSchema,
} from '../validators/mediaValidators.js'
import { validate } from '../middleware/validateMiddleware.js'
import {
  productCreateSchema,
  productUpdateSchema,
} from '../validators/productValidators.js'
import {
  adminOrderStatusSchema,
  adminOrderUpdateSchema,
  adminShippingSchema,
  adminRefundSchema,
} from '../validators/checkoutValidators.js'
const router = Router()

router.use(requireAuth, requireAdmin)

router.get('/dashboard', dashboard)

router.get('/uploads/status', uploadStatus)
function singleImage(req, res, next) {
  uploadProductImageMiddleware(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next)
    next()
  })
}

router.post('/uploads/image', singleImage, uploadImage)
router.post(
  '/uploads/video',
  (req, res, next) =>
    uploadProductVideoMiddleware(req, res, (err) => {
      if (err) return handleMulterError(err, req, res, next)
      next()
    }),
  uploadVideo,
)

router.get('/media', listMedia)
router.post('/media/upload', singleImage, uploadMedia)
router.get('/media/note-defaults', mediaNoteDefaults)
router.get('/media/:id', getMedia)
router.patch('/media/:id', validate(mediaUpdateSchema), updateMedia)
router.delete('/media/:id', deleteMedia)

router.post('/prompts/note', validate(notePromptSchema), notePrompt)
router.post('/prompts/background', validate(backgroundPromptSchema), backgroundPrompt)

router.get('/products', listProducts)
router.get('/products/:id', getProduct)
router.post('/products', validate(productCreateSchema), createProduct)
router.patch('/products/:id', validate(productUpdateSchema), updateProduct)
router.delete('/products/:id', deleteProduct)
router.delete('/products/:id/permanent', deleteProductPermanent)

router.get('/orders', listOrders)
router.get('/orders/:id', getOrder)
router.patch('/orders/:id/status', validate(adminOrderStatusSchema), updateOrderStatus)
router.post('/orders/:id/updates', validate(adminOrderUpdateSchema), addOrderUpdate)
router.patch('/orders/:id/shipping', validate(adminShippingSchema), updateShipping)
router.post('/orders/:id/refund', validate(adminRefundSchema), refundOrder)
router.post('/orders/:id/mark-cod-paid', markCodPaid)

router.get('/analytics/overview', analyticsOverview)
router.get('/analytics/products', analyticsProducts)

router.get('/newsletter', listNewsletter)

router.get('/offers', listOffers)
router.post('/offers', validate(offerCreateSchema), createOffer)
router.put('/offers/order', validate(offerReorderSchema), reorderOffers)
router.patch('/offers/:id', validate(offerUpdateSchema), updateOffer)
router.delete('/offers/:id', deleteOffer)

export default router
