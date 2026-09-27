/**
 * Import FIRST in integration tests. Forces dummy config so dotenv never picks up
 * real credentials from .env (dotenv does not override variables that already exist).
 */
const TEST_ENV = {
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  MONGODB_URI: 'mongodb://127.0.0.1:1/unused-in-tests',
  CLIENT_URL: 'http://localhost:5173',
  RAZORPAY_KEY_ID: 'rzp_test_dummy',
  RAZORPAY_KEY_SECRET: 'test_razorpay_key_secret',
  RAZORPAY_WEBHOOK_SECRET: 'test_razorpay_webhook_secret',
  RESEND_API_KEY: '',
  EMAIL_API_KEY: '',
  EMAIL_FROM: '',
  EMAIL_PROVIDER: '',
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
  RATE_LIMIT_MAX: '100000',
}

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] = value
}

export const TEST_SECRETS = Object.freeze({
  razorpayKeySecret: TEST_ENV.RAZORPAY_KEY_SECRET,
  razorpayWebhookSecret: TEST_ENV.RAZORPAY_WEBHOOK_SECRET,
})
