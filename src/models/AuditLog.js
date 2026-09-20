import mongoose from 'mongoose'

const auditLogSchema = new mongoose.Schema(
  {
    actorType: {
      type: String,
      enum: ['ADMIN', 'CUSTOMER', 'SYSTEM', 'WEBHOOK'],
      required: true,
    },
    actorId: { type: String, default: null },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true },
)

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 })
auditLogSchema.index({ createdAt: -1 })

export const AuditLog = mongoose.model('AuditLog', auditLogSchema)
