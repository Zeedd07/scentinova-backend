/**
 * Fix unique indexes that treat null as a value (blocks unpaid checkouts).
 * Run: node scripts/fixCheckoutUniqueIndexes.js
 */
import 'dotenv/config'
import mongoose from 'mongoose'

const DROP = [
  'payment.razorpayOrderId_1',
  'payment.razorpayPaymentId_1',
  'idempotencyKey_1',
]

await mongoose.connect(process.env.MONGODB_URI)
const orders = mongoose.connection.db.collection('orders')

const unsetResult = await orders.updateMany(
  {
    $or: [
      { 'payment.razorpayOrderId': null },
      { 'payment.razorpayPaymentId': null },
      { idempotencyKey: null },
    ],
  },
  {
    $unset: {
      'payment.razorpayOrderId': '',
      'payment.razorpayPaymentId': '',
      idempotencyKey: '',
    },
  },
)
console.log('unset null payment/idempotency fields:', unsetResult.modifiedCount)

for (const name of DROP) {
  try {
    await orders.dropIndex(name)
    console.log('dropped', name)
  } catch (err) {
    console.log('skip drop', name, err.message)
  }
}

await orders.createIndex(
  { 'payment.razorpayOrderId': 1 },
  {
    unique: true,
    name: 'payment.razorpayOrderId_1',
    partialFilterExpression: {
      'payment.razorpayOrderId': { $exists: true, $type: 'string' },
    },
  },
)
await orders.createIndex(
  { 'payment.razorpayPaymentId': 1 },
  {
    unique: true,
    name: 'payment.razorpayPaymentId_1',
    partialFilterExpression: {
      'payment.razorpayPaymentId': { $exists: true, $type: 'string' },
    },
  },
)
await orders.createIndex(
  { idempotencyKey: 1 },
  {
    unique: true,
    name: 'idempotencyKey_1',
    partialFilterExpression: {
      idempotencyKey: { $exists: true, $type: 'string' },
    },
  },
)

console.log('recreated partial unique indexes')
console.log(JSON.stringify(await orders.indexes(), null, 2))
await mongoose.disconnect()
