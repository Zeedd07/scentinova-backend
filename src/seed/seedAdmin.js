/**
 * Upsert the Scentinova admin account from env.
 * Updates password hash when ADMIN_PASSWORD changes.
 * Never logs the password.
 */
import bcrypt from 'bcryptjs'
import { connectDb, disconnectDb } from '../config/db.js'
import { env } from '../config/env.js'
import { Admin } from '../models/Admin.js'

async function seedAdmin() {
  await connectDb()

  const email = env.adminEmail.toLowerCase()
  const passwordHash = await bcrypt.hash(env.adminPassword, 12)
  const existing = await Admin.findOne({ email }).select('+passwordHash')

  if (existing) {
    existing.passwordHash = passwordHash
    existing.active = true
    existing.role = 'admin'
    if (!existing.name) existing.name = 'Scentinova Admin'
    await existing.save()
    console.log(`Admin password updated: ${email}`)
    await disconnectDb()
    return
  }

  await Admin.create({
    name: 'Scentinova Admin',
    email,
    passwordHash,
    role: 'admin',
    active: true,
  })

  console.log(`Admin created: ${email}`)
  await disconnectDb()
}

seedAdmin().catch(async (err) => {
  console.error('Admin seed failed:', err.message)
  try {
    await disconnectDb()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
