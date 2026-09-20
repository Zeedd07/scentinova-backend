import Razorpay from 'razorpay'
import { env, razorpayConfigured } from './env.js'
import { ApiError } from '../utils/ApiError.js'

let client = null

export function getRazorpay() {
  if (!razorpayConfigured()) {
    throw new ApiError(
      501,
      'PAYMENT_UNAVAILABLE',
      'Razorpay is not configured on the server.',
    )
  }
  if (!client) {
    client = new Razorpay({
      key_id: env.razorpay.keyId,
      key_secret: env.razorpay.keySecret,
    })
  }
  return client
}

export function getRazorpayKeyId() {
  if (!razorpayConfigured()) {
    throw new ApiError(
      501,
      'PAYMENT_UNAVAILABLE',
      'Razorpay is not configured on the server.',
    )
  }
  return env.razorpay.keyId
}

export { razorpayConfigured }
