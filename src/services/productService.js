import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { ApiError } from '../utils/ApiError.js'
import { slugify } from '../utils/slugify.js'
import { parsePagination, paginationMeta } from '../utils/pagination.js'
import {
  buildDeliveryUrl,
  isCloudinaryReady,
  safeDeleteUnreferencedAsset,
} from './imageService.js'
import { rupeesToPaise, paiseToRupees } from '../utils/money.js'
import {
  adminProductMedia,
  assertProductMediaRefs,
  pruneNoteImages,
  resolveNoteMedia,
} from './mediaService.js'

/** Admin-only media references and fee configuration never leave the admin API. */
function toPublic(product) {
  const { noteImages: _noteImages, backgroundAssetId: _bg, fees: _fees, ...rest } = product
  return rest
}

async function withAdminMedia(productDoc) {
  const json = withMediaUrls(productDoc.toJSON())
  return { ...json, media: await adminProductMedia(productDoc) }
}

function syncMoneyFields(input) {
  const out = { ...input }
  if (input.pricePaise != null && Number.isFinite(Number(input.pricePaise))) {
    out.pricePaise = Math.round(Number(input.pricePaise))
    out.price = paiseToRupees(out.pricePaise)
  } else if (input.price != null && Number.isFinite(Number(input.price))) {
    out.price = Number(input.price)
    out.pricePaise = rupeesToPaise(out.price)
  }
  return out
}

/** Prefer Cloudinary delivery URLs when public IDs exist (local /products paths often missing). */
function withMediaUrls(product) {
  if (!product || !isCloudinaryReady()) return product
  const out = { ...product }
  try {
    if (out.imagePublicId) {
      out.image = buildDeliveryUrl(out.imagePublicId)
    }
    if (Array.isArray(out.galleryPublicIds) && out.galleryPublicIds.length) {
      out.gallery = out.galleryPublicIds.map((id) => buildDeliveryUrl(id))
    } else if (out.imagePublicId) {
      out.gallery = [out.image]
    }
  } catch {
    /* keep stored URLs if Cloudinary URL build fails */
  }
  return out
}

export async function listPublicProducts(query) {
  const { page, limit, skip } = parsePagination(query)
  const filter = { active: true }

  if (query.category) filter.category = query.category
  if (query.featured === 'true') filter.featured = true
  if (query.search) {
    const re = new RegExp(String(query.search).trim(), 'i')
    filter.$or = [
      { name: re },
      { tagline: re },
      { category: re },
      { descriptors: re },
      { 'notes.top': re },
      { 'notes.heart': re },
      { 'notes.base': re },
    ]
  }

  let sort = { featured: -1, name: 1 }
  if (query.sort === 'name') sort = { name: 1 }
  if (query.sort === 'newest') sort = { createdAt: -1 }

  const [products, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ])

  return {
    products: products.map((p) => toPublic(withMediaUrls(p.toJSON()))),
    meta: paginationMeta(page, limit, total),
  }
}

export async function listFeaturedProducts() {
  const products = await Product.find({ active: true, featured: true }).sort({ name: 1 })
  return products.map((p) => toPublic(withMediaUrls(p.toJSON())))
}

export async function getProductBySlug(slug) {
  const product = await Product.findOne({ slug, active: true })
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  const noteMedia = await resolveNoteMedia(product)
  return { ...toPublic(withMediaUrls(product.toJSON())), noteMedia }
}

export async function listAdminProducts(query) {
  const { page, limit, skip } = parsePagination(query, { defaultLimit: 20 })
  const filter = {}
  if (query.active === 'true') filter.active = true
  if (query.active === 'false') filter.active = false

  const [products, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ])

  return {
    products: products.map((p) => withMediaUrls(p.toJSON())),
    meta: paginationMeta(page, limit, total),
  }
}

export async function getAdminProduct(id) {
  const product = await Product.findById(id)
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  return withAdminMedia(product)
}

export async function createProduct(input) {
  const slug = slugify(input.slug || input.name)
  const exists = await Product.findOne({ slug })
  if (exists) throw new ApiError(409, 'DUPLICATE', 'A product with that slug already exists.')

  const gallery = input.gallery?.length ? input.gallery : input.image ? [input.image] : []
  const galleryPublicIds = input.galleryPublicIds?.length
    ? input.galleryPublicIds
    : []

  const noteImages = pruneNoteImages(input.notes, input.noteImages || [])
  await assertProductMediaRefs({ noteImages, backgroundAssetId: input.backgroundAssetId })

  const money = syncMoneyFields(input)
  if (money.pricePaise == null) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Price is required.')
  }
  const product = await Product.create({
    ...input,
    ...money,
    slug,
    sku: input.sku || slug.toUpperCase(),
    gallery,
    imagePublicId: input.imagePublicId || null,
    galleryPublicIds,
    noteImages,
    backgroundAssetId: input.backgroundAssetId || null,
    trackInventory: input.trackInventory !== false,
    allowBackorder: Boolean(input.allowBackorder),
  })
  return withAdminMedia(product)
}

export async function updateProduct(id, input) {
  const product = await Product.findById(id)
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')

  const previousImagePublicId = product.imagePublicId
  const previousGalleryPublicIds = [...(product.galleryPublicIds || [])]

  if (input.slug || input.name) {
    const slug = slugify(input.slug || input.name || product.name)
    const clash = await Product.findOne({ slug, _id: { $ne: id } })
    if (clash) throw new ApiError(409, 'DUPLICATE', 'A product with that slug already exists.')
    product.slug = slug
  }

  const fields = [
    'name',
    'tagline',
    'description',
    'story',
    'currency',
    'size',
    'concentration',
    'category',
    'featured',
    'active',
    'badge',
    'image',
    'imagePublicId',
    'gallery',
    'galleryPublicIds',
    'notes',
    'descriptors',
    'stock',
    'accent',
    'sku',
    'trackInventory',
    'allowBackorder',
    'backgroundAssetId',
    'fees',
  ]

  if (input.noteImages !== undefined || input.notes !== undefined) {
    const notes = input.notes ?? product.notes?.toObject?.() ?? product.notes
    const current = (product.noteImages || []).map((n) => (n.toObject ? n.toObject() : n))
    input = { ...input, noteImages: pruneNoteImages(notes, input.noteImages ?? current) }
  }
  await assertProductMediaRefs({
    noteImages: input.noteImages,
    backgroundAssetId: input.backgroundAssetId,
  })

  for (const key of [...fields, 'noteImages']) {
    if (input[key] !== undefined) product[key] = input[key]
  }

  if (input.price !== undefined || input.pricePaise !== undefined) {
    const money = syncMoneyFields(input)
    product.price = money.price
    product.pricePaise = money.pricePaise
  }

  await product.save()

  // Optionally remove replaced primary image from Cloudinary
  if (
    input.imagePublicId !== undefined &&
    previousImagePublicId &&
    previousImagePublicId !== product.imagePublicId
  ) {
    await safeDeleteUnreferencedAsset(previousImagePublicId, {
      excludeProductId: product._id,
    })
  }

  // Optionally remove gallery public IDs that were dropped
  if (input.galleryPublicIds !== undefined) {
    const nextSet = new Set(product.galleryPublicIds || [])
    for (const oldId of previousGalleryPublicIds) {
      if (!nextSet.has(oldId)) {
        await safeDeleteUnreferencedAsset(oldId, { excludeProductId: product._id })
      }
    }
  }

  // Note images / backgrounds are shared library assets: never deleted here.
  return withAdminMedia(product)
}

export async function archiveProduct(id) {
  const product = await Product.findById(id)
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')

  const referenced = await Order.exists({ 'items.productId': product._id })
  product.active = false
  await product.save()

  // Do NOT delete Cloudinary assets on archive — orders may keep image URL snapshots,
  // and note/background library assets may be shared with other products.

  return {
    product: product.toJSON(),
    softDeleted: true,
    referencedByOrders: Boolean(referenced),
  }
}
