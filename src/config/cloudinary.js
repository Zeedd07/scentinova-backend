/**
 * Cloudinary configuration — server-side only.
 * Secrets must never be exposed to Vite / React.
 */
import { v2 as cloudinary } from 'cloudinary'
import { cloudinaryConfigured, env } from './env.js'
import { ApiError } from '../utils/ApiError.js'

let configured = false

export function configureCloudinary() {
  if (!cloudinaryConfigured()) {
    return null
  }

  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  })
  configured = true
  return cloudinary
}

export function getCloudinary() {
  if (!cloudinaryConfigured()) {
    throw new ApiError(
      501,
      'CLOUDINARY_UNAVAILABLE',
      'Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to the backend .env.',
    )
  }
  if (!configured) configureCloudinary()
  return cloudinary
}

export function isCloudinaryReady() {
  return cloudinaryConfigured()
}

export const CLOUDINARY_PRODUCT_FOLDER = 'scentinova/products'

export { cloudinary }
