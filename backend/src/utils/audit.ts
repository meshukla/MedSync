import type { Request } from 'express';
import { AuditLog } from '../models/AuditLog';
import type { AuthenticatedRequest } from '../middleware/auth';

export const recordAudit = async (
  req: Request,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
  },
) => {
  const authenticatedRequest = req as AuthenticatedRequest;
  await AuditLog.create({
    actorId: authenticatedRequest.user?.id,
    actorRole: authenticatedRequest.user?.role || 'system',
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    details: entry.details || {},
    ipAddress: req.ip,
  });
};
