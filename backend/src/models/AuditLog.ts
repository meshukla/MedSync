import { model, models, Schema, Types } from 'mongoose';
import type { UserRole } from './User';

export type AuditLogDocument = {
  _id: Types.ObjectId;
  actorId?: Types.ObjectId;
  actorRole: UserRole | 'system';
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  createdAt: Date;
};

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String, required: true },
    action: { type: String, required: true, maxlength: 120 },
    entityType: { type: String, required: true, maxlength: 80 },
    entityId: { type: String, required: true, maxlength: 120 },
    details: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, maxlength: 64 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export const AuditLog = models.AuditLog || model<AuditLogDocument>('AuditLog', auditLogSchema);
