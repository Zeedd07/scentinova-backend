/**
 * Reusable Cloudinary media library (note images, product backgrounds, misc).
 * Products reference assets by id; assets are never deleted while referenced.
 */
import mongoose from 'mongoose'
import {
  CLOUDINARY_BACKGROUND_FOLDER,
  CLOUDINARY_MEDIA_FOLDER,
  CLOUDINARY_NOTE_FOLDER,
} from '../config/cloudinary.js'
import { MediaAsset } from '../models/MediaAsset.js'
import { Product } from '../models/Product.js'
import { ApiError } from '../utils/ApiError.js'
import { slugify } from '../utils/slugify.js'
import { parsePagination, paginationMeta } from '../utils/pagination.js'
import { writeAudit } from './auditService.js'
import {
  buildAttachmentUrl,
  buildCroppedUrl,
  buildDeliveryUrl,
  destroyCloudinaryAssetStrict,
  isCloudinaryReady,
  uploadImageToPublicId,
} from './imageService.js'

export const MEDIA_PAGE_SIZE = 24
export const NOTE_TIERS = [
  { tier: 'TOP', key: 'top' },
  { tier: 'HEART', key: 'heart' },
  { tier: 'BASE', key: 'base' },
]
const NOTE_THUMB_WIDTH = 320

const FOLDER_BY_TYPE = {
  NOTE: CLOUDINARY_NOTE_FOLDER,
  PRODUCT_BACKGROUND: CLOUDINARY_BACKGROUND_FOLDER,
  PRODUCT_IMAGE: CLOUDINARY_MEDIA_FOLDER,
  OTHER: CLOUDINARY_MEDIA_FOLDER,
}

export function normalizeNoteKey(name) {
  return slugify(name).slice(0, 80)
}

export function defaultAltText(type, name) {
  const clean = String(name || '').trim()
  if (!clean) return ''
  if (type === 'NOTE') return `${clean} fragrance note`
  if (type === 'PRODUCT_BACKGROUND') return `${clean} product background`
  return clean
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',')
  return [...new Set(list.map((t) => slugify(t)).filter(Boolean))].slice(0, 20)
}

function safeUrl(fn, fallback) {
  if (!isCloudinaryReady()) return fallback
  try {
    return fn()
  } catch {
    return fallback
  }
}

export function serializeAsset(asset) {
  if (!asset) return null
  const doc = typeof asset.toJSON === 'function' ? asset.toJSON() : { ...asset }
  const id = doc.id || String(doc._id)
  delete doc._id
  return {
    ...doc,
    id,
    thumbUrl: safeUrl(() => buildCroppedUrl(doc.publicId, { width: NOTE_THUMB_WIDTH }), doc.url),
    previewUrl: safeUrl(() => buildDeliveryUrl(doc.publicId, { width: 1200 }), doc.url),
    downloadUrl: safeUrl(() => buildAttachmentUrl(doc.publicId, slugify(doc.name)), doc.url),
  }
}

function assertObjectId(id, label = 'asset') {
  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(404, 'MEDIA_NOT_FOUND', `That ${label} was not found.`)
  }
}

async function findAssetOr404(id) {
  assertObjectId(id)
  const asset = await MediaAsset.findById(id)
  if (!asset) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'That image was not found in the library.')
  return asset
}

export async function listAssets(query = {}) {
  const { page, limit, skip } = parsePagination(query, {
    defaultLimit: MEDIA_PAGE_SIZE,
    maxLimit: 60,
  })
  const filter = {}
  if (query.type) filter.type = String(query.type).toUpperCase()
  if (query.category) filter.category = String(query.category).toUpperCase()
  const search = String(query.search || '').trim().slice(0, 80)
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i')
    filter.$or = [{ name: re }, { tags: re }, { noteKey: re }]
  }

  const [assets, total] = await Promise.all([
    MediaAsset.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    MediaAsset.countDocuments(filter),
  ])
  return { assets: assets.map(serializeAsset), meta: paginationMeta(page, limit, total) }
}

function noteKeyMatcher(noteKey) {
  const parts = noteKey.split('-').filter(Boolean).map(escapeRegex)
  return new RegExp(`^[^a-z0-9]*${parts.join('[^a-z0-9]+')}[^a-z0-9]*$`, 'i')
}

/**
 * Products that use an asset — explicitly (override / background) or implicitly
 * (a note that falls back to this asset as its global default). Archived products count.
 */
export async function getAssetUsage(asset) {
  const explicit = await Product.find({
    $or: [{ 'noteImages.assetId': asset._id }, { backgroundAssetId: asset._id }],
  }).select('name slug active')

  const byId = new Map(explicit.map((p) => [String(p._id), p]))

  if (asset.type === 'NOTE' && asset.isDefault && asset.noteKey) {
    const re = noteKeyMatcher(asset.noteKey)
    const candidates = await Product.find({
      $or: [{ 'notes.top': re }, { 'notes.heart': re }, { 'notes.base': re }],
    }).select('name slug active notes noteImages')

    for (const p of candidates) {
      if (byId.has(String(p._id))) continue
      const usesDefault = NOTE_TIERS.some(({ tier, key }) =>
        (p.notes?.[key] || []).some((note) => {
          if (normalizeNoteKey(note) !== asset.noteKey) return false
          const override = (p.noteImages || []).find(
            (o) => o.tier === tier && o.noteKey === asset.noteKey,
          )
          return !override || (!override.assetId && !override.hideImage)
        }),
      )
      if (usesDefault) byId.set(String(p._id), p)
    }
  }

  const products = [...byId.values()].map((p) => ({
    id: String(p._id),
    name: p.name,
    slug: p.slug,
    active: p.active,
  }))
  return { count: products.length, products }
}

export async function getAsset(id) {
  const asset = await findAssetOr404(id)
  const usage = await getAssetUsage(asset)
  return { asset: serializeAsset(asset), usage }
}

/** Global default NOTE assets for the given note names/keys: `{ [noteKey]: asset }`. */
export async function getNoteDefaults(keys = []) {
  const list = (Array.isArray(keys) ? keys : String(keys || '').split(','))
    .map(normalizeNoteKey)
    .filter(Boolean)
  const unique = [...new Set(list)].slice(0, 90)
  if (!unique.length) return {}
  const assets = await MediaAsset.find({ type: 'NOTE', isDefault: true, noteKey: { $in: unique } })
  return Object.fromEntries(assets.map((a) => [a.noteKey, serializeAsset(a)]))
}

async function nextFreePublicId(folder, base) {
  for (let n = 1; n <= 200; n++) {
    const candidate = n === 1 ? `${folder}/${base}` : `${folder}/${base}-${n}`
    if (!(await MediaAsset.exists({ publicId: candidate }))) return candidate
  }
  throw new ApiError(409, 'DUPLICATE', 'Too many images share that name. Please choose another name.')
}

export async function uploadAsset(file, input, { adminId = null, ip = null } = {}) {
  const type = input.type
  const name = String(input.name || '').trim()
  const folder = FOLDER_BY_TYPE[type]
  const base = slugify(name).slice(0, 80) || 'asset'
  const noteKey = type === 'NOTE' ? normalizeNoteKey(name) : null

  let uploaded = null
  let publicId = null
  for (let attempt = 0; attempt < 5 && !uploaded; attempt++) {
    publicId = await nextFreePublicId(folder, attempt ? `${base}-${attempt + 1}` : base)
    try {
      uploaded = await uploadImageToPublicId(file, publicId, { tags: ['scentinova', type.toLowerCase()] })
    } catch (err) {
      // Public id exists on Cloudinary but not in the library — try the next suffix.
      if (err instanceof ApiError && err.code === 'DUPLICATE') continue
      throw err
    }
  }
  if (!uploaded) {
    throw new ApiError(409, 'DUPLICATE', 'An image with that name already exists. Please choose another name.')
  }

  let isDefault = false
  if (type === 'NOTE') {
    const existingDefault = await MediaAsset.exists({ type: 'NOTE', noteKey, isDefault: true })
    if (input.makeDefault && existingDefault) {
      await MediaAsset.updateMany({ type: 'NOTE', noteKey, isDefault: true }, { isDefault: false })
    }
    isDefault = Boolean(input.makeDefault) || !existingDefault
  }

  let asset
  try {
    asset = await MediaAsset.create({
      type,
      name,
      noteKey,
      isDefault,
      category: input.category || 'OTHER',
      publicId: uploaded.public_id,
      folder,
      url: uploaded.secure_url,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      format: uploaded.format ?? null,
      bytes: uploaded.bytes ?? null,
      altText: String(input.altText || '').trim() || defaultAltText(type, name),
      tags: normalizeTags(input.tags),
      createdBy: adminId,
    })
  } catch (err) {
    // Keep Cloudinary and the library in sync when the DB write fails.
    await destroyCloudinaryAssetStrict(uploaded.public_id).catch(() => {})
    throw err
  }

  await writeAudit({
    actorType: 'ADMIN',
    actorId: adminId ? String(adminId) : null,
    action: 'MEDIA_UPLOADED',
    entityType: 'MediaAsset',
    entityId: asset._id,
    metadata: { type, name, publicId: asset.publicId },
    ip,
  })

  return serializeAsset(asset)
}

export async function updateAsset(id, input, { adminId = null, ip = null } = {}) {
  const asset = await findAssetOr404(id)

  if (input.name !== undefined) {
    asset.name = String(input.name).trim()
    if (asset.type === 'NOTE') {
      const nextKey = normalizeNoteKey(asset.name)
      if (nextKey !== asset.noteKey && asset.isDefault) {
        const clash = await MediaAsset.exists({
          _id: { $ne: asset._id },
          type: 'NOTE',
          noteKey: nextKey,
          isDefault: true,
        })
        if (clash) asset.isDefault = false
      }
      asset.noteKey = nextKey
    }
  }
  if (input.altText !== undefined) {
    asset.altText = String(input.altText).trim() || defaultAltText(asset.type, asset.name)
  }
  if (input.tags !== undefined) asset.tags = normalizeTags(input.tags)
  if (input.category !== undefined) asset.category = input.category

  if (input.isDefault !== undefined && asset.type === 'NOTE') {
    if (input.isDefault) {
      await MediaAsset.updateMany(
        { _id: { $ne: asset._id }, type: 'NOTE', noteKey: asset.noteKey, isDefault: true },
        { isDefault: false },
      )
    }
    asset.isDefault = Boolean(input.isDefault)
  }

  await asset.save()
  await writeAudit({
    actorType: 'ADMIN',
    actorId: adminId ? String(adminId) : null,
    action: 'MEDIA_UPDATED',
    entityType: 'MediaAsset',
    entityId: asset._id,
    metadata: { fields: Object.keys(input) },
    ip,
  })
  return serializeAsset(asset)
}

export async function deleteAsset(id, { adminId = null, ip = null } = {}) {
  const asset = await findAssetOr404(id)
  const usage = await getAssetUsage(asset)
  if (usage.count > 0) {
    const noun = usage.count === 1 ? 'product' : 'products'
    throw new ApiError(
      409,
      'ASSET_IN_USE',
      `This image is currently used by ${usage.count} ${noun} and cannot be deleted until it is no longer in use.`,
      { usage },
    )
  }

  // Cloudinary first: if it fails, the library record stays so nothing is orphaned silently.
  await destroyCloudinaryAssetStrict(asset.publicId)
  await MediaAsset.deleteOne({ _id: asset._id })

  await writeAudit({
    actorType: 'ADMIN',
    actorId: adminId ? String(adminId) : null,
    action: 'MEDIA_DELETED',
    entityType: 'MediaAsset',
    entityId: asset._id,
    metadata: { type: asset.type, name: asset.name, publicId: asset.publicId },
    ip,
  })
  return { deleted: true, id: String(asset._id) }
}

/* ------------------------------------------------------------------ */
/* Product integration                                                 */
/* ------------------------------------------------------------------ */

/**
 * Keep only overrides that still match a current note, one per tier + noteKey,
 * and only when they carry information (asset, hide flag, or custom alt).
 */
export function pruneNoteImages(notes = {}, noteImages = []) {
  const valid = new Set()
  for (const { tier, key } of NOTE_TIERS) {
    for (const note of notes?.[key] || []) valid.add(`${tier}:${normalizeNoteKey(note)}`)
  }
  const out = new Map()
  for (const entry of noteImages || []) {
    const noteKey = normalizeNoteKey(entry.noteKey)
    const id = `${entry.tier}:${noteKey}`
    if (!valid.has(id)) continue
    const assetId = entry.assetId ? String(entry.assetId) : null
    const alt = entry.alt ? String(entry.alt).trim() : null
    const hideImage = Boolean(entry.hideImage)
    if (!assetId && !hideImage && !alt) continue
    out.set(id, { tier: entry.tier, noteKey, assetId, alt, hideImage })
  }
  return [...out.values()]
}

/** Reject references to missing assets or assets of the wrong type. */
export async function assertProductMediaRefs({ noteImages, backgroundAssetId } = {}) {
  const noteIds = [...new Set((noteImages || []).map((n) => n.assetId).filter(Boolean).map(String))]
  for (const id of noteIds) assertObjectId(id)
  if (noteIds.length) {
    const found = await MediaAsset.find({ _id: { $in: noteIds } }).select('type')
    const okIds = new Set(found.filter((a) => a.type === 'NOTE').map((a) => String(a._id)))
    const bad = noteIds.filter((id) => !okIds.has(id))
    if (bad.length) {
      throw new ApiError(400, 'INVALID_ASSET', 'One or more note images are missing from the library.', {
        noteImages: 'Choose note images from the media library.',
      })
    }
  }
  if (backgroundAssetId) {
    assertObjectId(backgroundAssetId)
    const bg = await MediaAsset.findById(backgroundAssetId).select('type')
    if (!bg || bg.type !== 'PRODUCT_BACKGROUND') {
      throw new ApiError(400, 'INVALID_ASSET', 'The selected background is not in the media library.', {
        backgroundAssetId: 'Choose a product background from the media library.',
      })
    }
  }
}

async function loadNoteAssets(product) {
  const overrideIds = (product.noteImages || []).map((n) => n.assetId).filter(Boolean)
  const keys = new Set()
  for (const { key } of NOTE_TIERS) {
    for (const note of product.notes?.[key] || []) {
      const k = normalizeNoteKey(note)
      if (k) keys.add(k)
    }
  }
  const [overrides, defaults] = await Promise.all([
    overrideIds.length ? MediaAsset.find({ _id: { $in: overrideIds } }) : [],
    keys.size ? MediaAsset.find({ type: 'NOTE', isDefault: true, noteKey: { $in: [...keys] } }) : [],
  ])
  return {
    byId: new Map(overrides.map((a) => [String(a._id), a])),
    byKey: new Map(defaults.map((a) => [a.noteKey, a])),
  }
}

function publicNoteImage(asset, alt) {
  const src = (w) => safeUrl(() => buildCroppedUrl(asset.publicId, { width: w }), asset.url)
  return {
    url: src(NOTE_THUMB_WIDTH),
    srcSet: isCloudinaryReady() ? `${src(160)} 160w, ${src(NOTE_THUMB_WIDTH)} 320w, ${src(640)} 640w` : null,
    alt,
    width: NOTE_THUMB_WIDTH,
    height: NOTE_THUMB_WIDTH,
  }
}

/**
 * Public, safe note media: `{ top: [{ name, image|null }], heart: [...], base: [...] }`.
 * Resolution: product override → global default for the note → none.
 */
export async function resolveNoteMedia(product) {
  const { byId, byKey } = await loadNoteAssets(product)
  const out = { top: [], heart: [], base: [] }
  for (const { tier, key } of NOTE_TIERS) {
    for (const raw of product.notes?.[key] || []) {
      const name = String(raw || '').trim()
      if (!name) continue
      const noteKey = normalizeNoteKey(name)
      const override = (product.noteImages || []).find((o) => o.tier === tier && o.noteKey === noteKey)
      let asset = null
      if (override?.assetId) asset = byId.get(String(override.assetId)) || null
      else if (!override?.hideImage) asset = byKey.get(noteKey) || null
      const alt = override?.alt || asset?.altText || defaultAltText('NOTE', name)
      out[key].push({ name, image: asset ? publicNoteImage(asset, alt) : null })
    }
  }
  return out
}

/** Admin editor payload: override/default assets keyed for quick lookup, plus background. */
export async function adminProductMedia(product) {
  const { byId, byKey } = await loadNoteAssets(product)
  const background = product.backgroundAssetId
    ? await MediaAsset.findById(product.backgroundAssetId)
    : null
  const toMap = (m) => Object.fromEntries([...m.entries()].map(([k, a]) => [k, serializeAsset(a)]))
  return {
    noteAssets: toMap(byId),
    noteDefaults: toMap(byKey),
    backgroundAsset: serializeAsset(background),
  }
}
