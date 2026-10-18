import mongoose from 'mongoose'
import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { InventoryReservation } from '../models/InventoryReservation.js'
import { ApiError } from '../utils/ApiError.js'
import { slugify } from '../utils/slugify.js'
import { parsePagination, paginationMeta } from '../utils/pagination.js'
import {
  buildDeliveryUrl,
  buildVideoPosterUrl,
  buildVideoUrl,
  isCloudinaryReady,
  safeDeleteUnreferencedAsset,
  safeDeleteUnreferencedVideo,
} from './imageService.js'
import { rupeesToPaise, paiseToRupees } from '../utils/money.js'
import {
  adminProductMedia,
  assertProductMediaRefs,
  pruneNoteImages,
  resolveNoteMedia,
} from './mediaService.js'
import { getLiveSales, priceWithSale, publicSaleFor } from './saleService.js'
import { resolveSizes, sizeLabel, sizeMediaIds } from '../utils/productSizes.js'

/**
 * Admin-only media references, fee and discount configuration never leave the admin API;
 * the resulting sale price is exposed as `sale` instead.
 */
function publicSizeSale(product, pricePaise, liveSales) {
  const priced = priceWithSale(product, pricePaise, liveSales)
  if (!priced) return null
  return {
    kind: priced.sale.kind,
    name: priced.sale.name,
    percentOff: priced.sale.percentOff,
    pricePaise: priced.salePricePaise,
    price: paiseToRupees(priced.salePricePaise),
    endsAt: priced.sale.endsAt ?? null,
  }
}

function toPublic(product, liveSales = []) {
  const {
    noteImages: _noteImages,
    backgroundAssetId: _bg,
    fees: _fees,
    discount,
    ...rest
  } = product
  const priced = { ...rest, discount }
  const sizes = resolveSizes(priced).map((s) => {
    const pub = {
      ml: s.ml,
      label: s.label,
      pricePaise: s.pricePaise,
      price: s.price,
      sale: publicSizeSale(priced, s.pricePaise, liveSales),
    }
    if (s.gallery?.length) {
      pub.gallery = s.gallery
      pub.galleryScales = s.galleryScales
    }
    if (s.videos?.length) pub.videos = s.videos
    return pub
  })
  return { ...rest, sizes, sale: publicSaleFor(priced, liveSales) }
}

/** When sizes are sent, the first row is the product's price and the size label. */
function applySizeFields(input) {
  if (!Array.isArray(input.sizes) || input.sizes.length === 0) return input
  const [first] = input.sizes
  return {
    ...input,
    price: first.price,
    pricePaise: first.pricePaise,
    size: sizeLabel(first.ml),
  }
}

/** A fixed discounted price must stay below the regular price it discounts. */
function assertDiscountFits(discount, pricePaise) {
  if (discount?.type !== 'PRICE' || discount.salePricePaise == null) return
  if (discount.salePricePaise >= pricePaise) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'The discounted price must be lower than the regular price.',
    )
  }
}

function withResolvedSizes(json) {
  return { ...json, sizes: resolveSizes(json) }
}

async function withAdminMedia(productDoc) {
  const json = withResolvedSizes(withMediaUrls(productDoc.toJSON()))
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

function rewriteSizeMedia(size) {
  if (!size || typeof size !== 'object') return size
  const next = { ...size }
  const ids = Array.isArray(next.galleryPublicIds) ? next.galleryPublicIds : []
  if (ids.some(Boolean)) {
    const gallery = Array.isArray(next.gallery) ? next.gallery : []
    next.gallery = ids
      .map((id, i) => (id ? buildDeliveryUrl(id) : gallery[i]))
      .filter(Boolean)
  }
  if (Array.isArray(next.videos) && next.videos.length) {
    next.videos = next.videos.map((v) =>
      v?.publicId
        ? { ...v, url: buildVideoUrl(v.publicId), posterUrl: buildVideoPosterUrl(v.publicId) }
        : v,
    )
  }
  return next
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
    if (Array.isArray(out.videos) && out.videos.length) {
      out.videos = out.videos.map((v) =>
        v.publicId
          ? { ...v, url: buildVideoUrl(v.publicId), posterUrl: buildVideoPosterUrl(v.publicId) }
          : v,
      )
    }
    if (Array.isArray(out.sizes) && out.sizes.length) {
      out.sizes = out.sizes.map((size) => rewriteSizeMedia(size))
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

  const [products, total, liveSales] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(limit),
    Product.countDocuments(filter),
    getLiveSales(),
  ])

  return {
    products: products.map((p) => toPublic(withMediaUrls(p.toJSON()), liveSales)),
    meta: paginationMeta(page, limit, total),
  }
}

export async function listFeaturedProducts() {
  const [products, liveSales] = await Promise.all([
    Product.find({ active: true, featured: true }).sort({ name: 1 }),
    getLiveSales(),
  ])
  return products.map((p) => toPublic(withMediaUrls(p.toJSON()), liveSales))
}

export async function getProductBySlug(slug) {
  const product = await Product.findOne({ slug, active: true })
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  const [noteMedia, liveSales] = await Promise.all([resolveNoteMedia(product), getLiveSales()])
  return { ...toPublic(withMediaUrls(product.toJSON()), liveSales), noteMedia }
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
    products: products.map((p) => withResolvedSizes(withMediaUrls(p.toJSON()))),
    meta: paginationMeta(page, limit, total),
  }
}

/** Categories in use on any product (archived included), one entry per name ignoring case. */
export async function listProductCategories() {
  const raw = await Product.distinct('category')
  const byKey = new Map()
  for (const value of raw) {
    const name = String(value || '').trim()
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name)
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b))
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

  input = applySizeFields(input)
  const money = syncMoneyFields(input)
  if (money.pricePaise == null) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Price is required.')
  }
  assertDiscountFits(input.discount, money.pricePaise)
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
  const previousVideoIds = (product.videos || []).map((v) => v.publicId)
  const previousSizeMedia = sizeMediaIds(product.sizes)

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
    'sizes',
    'concentration',
    'category',
    'featured',
    'active',
    'badge',
    'image',
    'imagePublicId',
    'gallery',
    'galleryPublicIds',
    'galleryScales',
    'videos',
    'notes',
    'descriptors',
    'stock',
    'accent',
    'sku',
    'trackInventory',
    'allowBackorder',
    'backgroundAssetId',
    'fees',
    'discount',
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

  if (input.sizes !== undefined) input = applySizeFields(input)

  if (input.price !== undefined || input.pricePaise !== undefined) {
    const money = syncMoneyFields(input)
    product.price = money.price
    product.pricePaise = money.pricePaise
    if (input.size !== undefined) product.size = input.size
    if (input.sizes !== undefined) product.sizes = input.sizes
  }

  if (input.discount !== undefined || input.price !== undefined || input.pricePaise !== undefined) {
    assertDiscountFits(product.discount, product.pricePaise)
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

  if (input.videos !== undefined) {
    const kept = new Set((product.videos || []).map((v) => v.publicId))
    for (const oldId of previousVideoIds) {
      if (!kept.has(oldId)) {
        await safeDeleteUnreferencedVideo(oldId, { excludeProductId: product._id })
      }
    }
  }

  if (input.sizes !== undefined) {
    const nextSizeMedia = sizeMediaIds(product.sizes)
    const nextImages = new Set(nextSizeMedia.imageIds)
    for (const oldId of previousSizeMedia.imageIds) {
      if (!nextImages.has(oldId)) {
        await safeDeleteUnreferencedAsset(oldId, { excludeProductId: product._id })
      }
    }
    const nextVideos = new Set(nextSizeMedia.videoIds)
    for (const oldId of previousSizeMedia.videoIds) {
      if (!nextVideos.has(oldId)) {
        await safeDeleteUnreferencedVideo(oldId, { excludeProductId: product._id })
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

/**
 * Permanently removes a product. Orders keep their own item snapshots (name, image,
 * price), so order history is unaffected. Blocked while a checkout still holds stock
 * for it, because committing that payment needs the product document.
 */
export async function deleteProductPermanently(id) {
  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  }
  const product = await Product.findById(id)
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')

  const pending = await InventoryReservation.exists({
    productId: product._id,
    status: 'ACTIVE',
    expiresAt: { $gt: new Date() },
  })
  if (pending) {
    throw new ApiError(
      409,
      'PRODUCT_IN_CHECKOUT',
      'A customer is paying for this perfume right now. Archive it instead, or try again in a few minutes.',
    )
  }

  const orderCount = await Order.countDocuments({ 'items.productId': product._id })
  const videoIds = [
    ...(product.videos || []).map((v) => v.publicId),
    ...sizeMediaIds(product.sizes).videoIds,
  ]
  await product.deleteOne()

  // Videos are never snapshotted on orders, so they can go with the product.
  for (const publicId of videoIds) {
    await safeDeleteUnreferencedVideo(publicId)
  }

  // Images stay on Cloudinary: past orders still show them from their snapshots.
  return { id: String(product._id), name: product.name, deleted: true, orderCount }
}
