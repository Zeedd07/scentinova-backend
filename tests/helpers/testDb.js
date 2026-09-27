import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'

let server = null

export async function startTestDb() {
  server = await MongoMemoryServer.create()
  mongoose.set('strictQuery', true)
  await mongoose.connect(server.getUri())
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))
}

export async function clearTestDb() {
  const collections = Object.values(mongoose.connection.collections)
  await Promise.all(collections.map((c) => c.deleteMany({})))
}

export async function stopTestDb() {
  await mongoose.disconnect()
  if (server) await server.stop()
  server = null
}
