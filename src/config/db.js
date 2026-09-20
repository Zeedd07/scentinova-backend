import mongoose from 'mongoose'
import { env } from './env.js'

export async function connectDb() {
  try {
    mongoose.set('strictQuery', true)
    await mongoose.connect(env.mongodbUri)
    console.log('[MongoDB] Connected')
  } catch (err) {
    console.error('MongoDB connection failed.')
    console.error('Check MONGODB_URI and make sure MongoDB is running.')
    console.error(err.message)
    process.exit(1)
  }
}

export async function disconnectDb() {
  await mongoose.connection.close()
  console.log('[MongoDB] Disconnected')
}
