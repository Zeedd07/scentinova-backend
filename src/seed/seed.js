/**
 * Seed the four Scentinova house signatures.
 * Upserts by slug - no duplicates.
 */
import { connectDb, disconnectDb } from '../config/db.js'
import { Product } from '../models/Product.js'

const PRODUCTS = [
  {
    name: 'Lunar Leather',
    slug: 'lunar-leather',
    sku: 'LUNAR-LEATHER',
    tagline: 'Dark. Warm. Magnetic.',
    price: 999,
    pricePaise: 99900,
    size: '50ML',
    concentration: 'Parfum',
    category: 'Oriental',
    featured: true,
    active: true,
    badge: 'House Signature',
    image: '/products/lunar-leather.png',
    gallery: ['/products/lunar-leather.png', '/products/lunar-leather-pack.png'],
    notes: {
      top: ['Pink Pepper', 'Raspberry'],
      heart: ['Amber', 'Leather', 'Saffron'],
      base: ['Agarwood', 'Bakhoor'],
    },
    descriptors: ['Pink Pepper', 'Leather', 'Agarwood', 'Bakhoor'],
    description:
      'Pink pepper and raspberry open into amber, leather, and saffron - grounded in agarwood and bakhoor.',
    story: 'The night, bottled.',
    accent: 'lunar',
    stock: 48,
    currency: 'INR',
    trackInventory: true,
    allowBackorder: false,
  },
  {
    name: 'Oud on the Petals',
    slug: 'oud-on-the-petals',
    sku: 'OUD-PETALS',
    tagline: 'Floral elegance wrapped in precious oud.',
    price: 999,
    pricePaise: 99900,
    size: '50ML',
    concentration: 'Pure Parfum',
    category: 'Floral',
    featured: true,
    active: true,
    badge: null,
    image: '/products/oud-on-the-petals.png',
    gallery: [
      '/products/oud-on-the-petals.png',
      '/products/oud-on-the-petals-pack.png',
    ],
    notes: {
      top: ['White Florals', 'Orange Blossom'],
      heart: ['Jasmine Sambac', 'Amber'],
      base: ['Indian Agarwood', 'Incense'],
    },
    descriptors: ['White Florals', 'Jasmine Sambac', 'Indian Agarwood', 'Incense'],
    description:
      'White florals and orange blossom into jasmine sambac and amber - finished with Indian agarwood and incense.',
    story: 'A bloom held in resin.',
    accent: 'petals',
    stock: 48,
    currency: 'INR',
    trackInventory: true,
    allowBackorder: false,
  },
  {
    name: 'Masai-Mara',
    slug: 'masai-mara',
    sku: 'MASAI-MARA',
    tagline: 'Wild. Smoldering. Unrestrained.',
    price: 999,
    pricePaise: 99900,
    size: '50ML',
    concentration: 'Pure Parfum',
    category: 'Woody',
    featured: true,
    active: true,
    badge: null,
    image: '/products/masai-mara.png',
    gallery: ['/products/masai-mara.png', '/products/masai-mara-pack.png'],
    notes: {
      top: ['Saffron', 'Leather', 'Wild Berries'],
      heart: ['Nutmeg', 'Taif Rose', 'Frankincense'],
      base: ['Sandalwood', 'Amber', 'Leather', 'Olibanum'],
    },
    descriptors: ['Saffron', 'Taif Rose', 'Sandalwood', 'Leather'],
    description:
      'Saffron, leather, and wild berries open into nutmeg, Taif rose, and frankincense - settling into sandalwood, amber, leather, and olibanum.',
    story: 'Open land. Ember air.',
    accent: 'mara',
    stock: 48,
    currency: 'INR',
    trackInventory: true,
    allowBackorder: false,
  },
  {
    name: 'Seaweed',
    slug: 'seaweed',
    sku: 'SEAWEED',
    tagline: 'Marine clarity with a darker skin of musk.',
    price: 999,
    pricePaise: 99900,
    size: '50ML',
    concentration: 'Pure Parfum',
    category: 'Fresh',
    featured: true,
    active: true,
    badge: null,
    image: '/products/seaweed.png',
    gallery: ['/products/seaweed.png', '/products/seaweed-pack.png'],
    notes: {
      top: ['Calabrian Bergamot'],
      heart: ['Calone', 'Hedione', 'Sea Water'],
      base: ['Musk', 'Cedarwood'],
    },
    descriptors: ['Calabrian Bergamot', 'Sea Water', 'Musk', 'Cedarwood'],
    description:
      'Calabrian bergamot into calone, hedione, and sea water - drying down to musk and cedarwood.',
    story: 'Tide, then silence.',
    accent: 'marine',
    stock: 48,
    currency: 'INR',
    trackInventory: true,
    allowBackorder: false,
  },
]

async function seed() {
  await connectDb()

  let created = 0
  let updated = 0

  for (const data of PRODUCTS) {
    const existing = await Product.findOne({ slug: data.slug })
    if (existing) {
      // Keep Cloudinary media if already uploaded — seed defaults are local /products paths.
      const preserveMedia =
        existing.imagePublicId ||
        (Array.isArray(existing.galleryPublicIds) && existing.galleryPublicIds.length > 0) ||
        (typeof existing.image === 'string' && existing.image.includes('res.cloudinary.com'))

      const next = { ...data }
      if (preserveMedia) {
        delete next.image
        delete next.gallery
        delete next.imagePublicId
        delete next.galleryPublicIds
      }

      Object.assign(existing, next)
      await existing.save()
      updated += 1
      console.log(`  updated: ${data.name}${preserveMedia ? ' (kept Cloudinary media)' : ''}`)
    } else {
      await Product.create(data)
      created += 1
      console.log(`  created: ${data.name}`)
    }
  }

  const total = await Product.countDocuments({
    slug: { $in: PRODUCTS.map((p) => p.slug) },
  })

  console.log(
    `Seeded ${total} Scentinova products. (${created} new, ${updated} updated)`,
  )
  await disconnectDb()
}

seed().catch(async (err) => {
  console.error('Seed failed:', err.message)
  try {
    await disconnectDb()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
