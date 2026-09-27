/**
 * Development-only Resend connectivity check.
 * Usage: node scripts/testResendEmail.js [recipient@example.com]
 *
 * Does not create a public HTTP endpoint.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const to = process.argv[2] || process.env.ADMIN_EMAIL || ''

if (!process.env.RESEND_API_KEY) {
  console.error('RESEND_API_KEY is not set.')
  process.exit(1)
}
if (!process.env.EMAIL_FROM) {
  console.error('EMAIL_FROM is not set.')
  process.exit(1)
}
if (!to || !to.includes('@')) {
  console.error('Pass a recipient: node scripts/testResendEmail.js you@example.com')
  process.exit(1)
}

const { Resend } = await import('resend')
const resend = new Resend(process.env.RESEND_API_KEY)
const from = process.env.EMAIL_FROM.includes('<')
  ? process.env.EMAIL_FROM
  : `Scentinova <${process.env.EMAIL_FROM}>`

const { data, error } = await resend.emails.send(
  {
    from,
    to: [to],
    subject: 'Scentinova — Resend test',
    html: '<p>Resend is configured correctly for Scentinova.</p>',
    text: 'Resend is configured correctly for Scentinova.',
  },
  { idempotencyKey: `resend-test:${Date.now()}` },
)

if (error) {
  console.error('Send failed:', error.message || error)
  process.exit(1)
}

console.log('Test email accepted by Resend. messageId=', data?.id)
console.log('Recipient domain:', to.split('@')[1])
