import { asyncHandler } from '../utils/asyncHandler.js'
import * as productService from '../services/productService.js'

export const listProducts = asyncHandler(async (req, res) => {
  const result = await productService.listPublicProducts(req.query)
  res.json({ success: true, data: { products: result.products }, meta: result.meta })
})

export const listFeatured = asyncHandler(async (_req, res) => {
  const products = await productService.listFeaturedProducts()
  res.json({ success: true, data: { products } })
})

export const getBySlug = asyncHandler(async (req, res) => {
  const product = await productService.getProductBySlug(req.params.slug)
  res.json({ success: true, data: { product } })
})

export const adminList = asyncHandler(async (req, res) => {
  const result = await productService.listAdminProducts(req.query)
  res.json({ success: true, data: { products: result.products }, meta: result.meta })
})

export const adminGet = asyncHandler(async (req, res) => {
  const product = await productService.getAdminProduct(req.params.id)
  res.json({ success: true, data: { product } })
})

export const adminCreate = asyncHandler(async (req, res) => {
  const product = await productService.createProduct(req.body)
  res.status(201).json({ success: true, data: { product } })
})

export const adminUpdate = asyncHandler(async (req, res) => {
  const product = await productService.updateProduct(req.params.id, req.body)
  res.json({ success: true, data: { product } })
})

export const adminDelete = asyncHandler(async (req, res) => {
  const result = await productService.archiveProduct(req.params.id)
  res.json({ success: true, data: result })
})
