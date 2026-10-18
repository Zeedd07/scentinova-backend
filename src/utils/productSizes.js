/**
 * Bottle sizes. A product may list several (10ml, 20ml, 50ml), each with its own price.
 * Products saved before sizes existed are treated as one size, parsed from `size`.
 */
import { paiseToRupees, rupeesToPaise } from './money.js'

export const MAX_PRODUCT_SIZES = 6
export const SIZE_ML_MIN = 1
export const SIZE_ML_MAX = 500

export function sizeLabel(ml) {
  return `${ml}ml`
}

/** Whole millilitres from a stored label such as "50ML" or "50ml", or null. */
export function parseSizeMl(size) {
  const match = /(\d+)/.exec(String(size || ''))
  if (!match) return null
  const ml = Number(match[1])
  if (!Number.isInteger(ml) || ml < SIZE_ML_MIN || ml > SIZE_ML_MAX) return null
  return ml
}

/** Photos and videos stored on one size. Empty lists are omitted so the shop uses the main bottle. */
function sizeMedia(raw) {
  const gallery = Array.isArray(raw?.gallery) ? raw.gallery.map((url) => String(url)).filter(Boolean) : []
  const ids = Array.isArray(raw?.galleryPublicIds) ? raw.galleryPublicIds : []
  const scales = Array.isArray(raw?.galleryScales) ? raw.galleryScales : []
  const videos = Array.isArray(raw?.videos) ? raw.videos.filter((v) => v && (v.url || v.publicId)) : []
  const media = {}
  if (gallery.length) {
    media.gallery = gallery
    media.galleryPublicIds = gallery.map((_, i) => (ids[i] ? String(ids[i]) : ''))
    media.galleryScales = gallery.map((_, i) => {
      const n = Number(scales[i])
      if (!Number.isFinite(n)) return 1
      return Math.min(2, Math.max(0.5, n))
    })
  }
  if (videos.length) {
    media.videos = videos.map((v) => ({
      publicId: v.publicId,
      url: v.url,
      posterUrl: v.posterUrl ?? null,
      width: v.width ?? null,
      height: v.height ?? null,
      duration: v.duration ?? null,
    }))
  }
  return media
}

/** Cloudinary ids attached to bottle sizes, so a removed product photo is kept while a size still uses it. */
export function sizeMediaIds(sizes) {
  const imageIds = []
  const videoIds = []
  for (const raw of sizes || []) {
    const size = raw?.toObject ? raw.toObject() : raw
    for (const id of size?.galleryPublicIds || []) if (id) imageIds.push(String(id))
    for (const video of size?.videos || []) if (video?.publicId) videoIds.push(String(video.publicId))
  }
  return { imageIds, videoIds }
}

function pricePaiseOf(product) {
  if (product?.pricePaise != null && Number.isFinite(Number(product.pricePaise))) {
    return Math.round(Number(product.pricePaise))
  }
  if (product?.price != null && Number.isFinite(Number(product.price))) {
    return rupeesToPaise(product.price)
  }
  return null
}

/**
 * Sizes a shopper can buy, in the admin's order. The first one is the default
 * shown on cards and used when an older cart sends no size.
 */
export function resolveSizes(product) {
  const stored = Array.isArray(product?.sizes) ? product.sizes : []
  const clean = []
  const seen = new Set()
  for (const raw of stored) {
    const ml = Number(raw?.ml)
    const pricePaise = Math.round(Number(raw?.pricePaise))
    if (!Number.isInteger(ml) || ml < SIZE_ML_MIN || ml > SIZE_ML_MAX) continue
    if (!Number.isInteger(pricePaise) || pricePaise < 100) continue
    if (seen.has(ml)) continue
    seen.add(ml)
    clean.push({
      ml,
      pricePaise,
      price: paiseToRupees(pricePaise),
      label: sizeLabel(ml),
      ...sizeMedia(raw),
    })
  }
  if (clean.length) return clean

  const pricePaise = pricePaiseOf(product)
  if (pricePaise == null || pricePaise < 100) return []
  const ml = parseSizeMl(product?.size) ?? 50
  return [{ ml, pricePaise, price: paiseToRupees(pricePaise), label: sizeLabel(ml) }]
}

/** The size for `sizeMl`, or the default when none was sent. Null when it is not sold. */
export function findSize(product, sizeMl) {
  const sizes = resolveSizes(product)
  if (sizeMl == null || sizeMl === '') return sizes[0] || null
  const ml = Number(sizeMl)
  return sizes.find((s) => s.ml === ml) || null
}
