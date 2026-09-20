import { AuditLog } from '../models/AuditLog.js'

export async function writeAudit({
  actorType,
  actorId = null,
  action,
  entityType,
  entityId,
  metadata = {},
  ip = null,
  userAgent = null,
}) {
  try {
    await AuditLog.create({
      actorType,
      actorId,
      action,
      entityType,
      entityId: String(entityId),
      metadata,
      ip,
      userAgent,
    })
  } catch {
    // Never fail the main request because audit write failed
  }
}
