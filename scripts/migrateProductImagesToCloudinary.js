/**
 * One-off: upload local product images to Cloudinary and update Mongo products.
 * Run: node scripts/migrateProductImagesToCloudinary.js
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { Product } from '../src/models/Product.js'
import { configureCloudinary } from '../src/config/cloudinary.js'
import { uploadProductImage } from '../src/services/imageService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

const FRONTEND_PUBLIC = path.resolve(__dirname, '../../scentinova/public/products')

const JOBS = [
  {
    slug: 'lunar-leather',
    // hero already on Cloudinary — still upload pack if gallery has local path
    hero: null,
    pack: 'lunar-leather-pack.png',
  },
  {
    slug: 'masai-mara',
    hero: 'masai-mara.png',
    pack: 'masai-mara-pack.png',
  },
  {
    slug: 'oud-on-the-petals',
    hero: 'oud-on-the-petals.png',
    pack: 'oud-on-the-petals-pack.png',
  },
  {
    slug: 'seaweed',
    hero: 'seaweed.png',
    pack: 'seaweed-pack.png',
  },
]

function fileAsMulter(filePath) {
  const buffer = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mimetype =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return {
    buffer,
    mimetype,
    size: buffer.length,
    originalname: path.basename(filePath),
  }
}

async function main() {
  configureCloudinary()
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('[migrate] Connected')

  for (const job of JOBS) {
    const product = await Product.findOne({ slug: job.slug })
    if (!product) {
      console.warn(`[migrate] skip missing product: ${job.slug}`)
      continue
    }

    let image = product.image
    let imagePublicId = product.imagePublicId
    const gallery = [...(product.gallery || [])]
    const galleryPublicIds = [...(product.galleryPublicIds || [])]

    if (job.hero) {
      const heroPath = path.join(FRONTEND_PUBLIC, job.hero)
      if (!fs.existsSync(heroPath)) {
        console.warn(`[migrate] missing file: ${heroPath}`)
      } else {
        const uploaded = await uploadProductImage(fileAsMulter(heroPath), {
          slug: job.slug,
          role: 'primary',
        })
        image = uploaded.url
        imagePublicId = uploaded.public_id
        console.log(`[migrate] ${job.slug} hero → ${uploaded.public_id}`)
      }
    }

    let packUrl = null
    let packPublicId = null
    if (job.pack) {
      const packPath = path.join(FRONTEND_PUBLIC, job.pack)
      if (!fs.existsSync(packPath)) {
        console.warn(`[migrate] missing file: ${packPath}`)
      } else {
        const uploaded = await uploadProductImage(fileAsMulter(packPath), {
          slug: job.slug,
          role: 'gallery',
        })
        packUrl = uploaded.url
        packPublicId = uploaded.public_id
        console.log(`[migrate] ${job.slug} pack → ${uploaded.public_id}`)
      }
    }

    const nextGallery = []
    const nextGalleryIds = []

    // Primary image first in gallery (matches Lunar Leather pattern)
    if (image) {
      nextGallery.push(image)
      if (imagePublicId) nextGalleryIds.push(imagePublicId)
    }
    if (packUrl) {
      nextGallery.push(packUrl)
      if (packPublicId) nextGalleryIds.push(packPublicId)
    } else {
      // keep any existing non-local / cloudinary gallery entries that aren't the hero
      for (let i = 0; i < gallery.length; i++) {
        const url = gallery[i]
        if (!url || url === image) continue
        if (url.startsWith('/')) continue
        nextGallery.push(url)
        const pid = galleryPublicIds[i]
        if (pid && pid !== imagePublicId) nextGalleryIds.push(pid)
      }
    }

    product.image = image
    product.imagePublicId = imagePublicId
    product.gallery = nextGallery
    product.galleryPublicIds = nextGalleryIds
    await product.save()
    console.log(`[migrate] saved ${job.slug}`)
  }

  await mongoose.disconnect()
  console.log('[migrate] Done')
}

main().catch(async (err) => {
  console.error(err)
  try {
    await mongoose.disconnect()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
