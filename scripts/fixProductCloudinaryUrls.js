import 'dotenv/config'
import mongoose from 'mongoose'
import { configureCloudinary } from '../src/config/cloudinary.js'
import { buildDeliveryUrl } from '../src/services/imageService.js'

configureCloudinary()
await mongoose.connect(process.env.MONGODB_URI)

const col = mongoose.connection.db.collection('products')
const products = await col.find({}).toArray()

for (const p of products) {
  if (!p.imagePublicId && !(p.galleryPublicIds?.length)) {
    console.log('skip (no cloudinary ids):', p.slug)
    continue
  }
  const image = p.imagePublicId ? buildDeliveryUrl(p.imagePublicId) : p.image
  const gallery = p.galleryPublicIds?.length
    ? p.galleryPublicIds.map((id) => buildDeliveryUrl(id))
    : p.imagePublicId
      ? [image]
      : p.gallery || []

  await col.updateOne({ _id: p._id }, { $set: { image, gallery } })
  console.log('updated', p.slug)
}

await mongoose.disconnect()
console.log('done')
