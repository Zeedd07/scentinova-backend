import mongoose from 'mongoose'

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin'], default: 'admin' },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
)

adminSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id.toString()
    delete ret._id
    delete ret.passwordHash
    return ret
  },
})

export const Admin = mongoose.model('Admin', adminSchema)
