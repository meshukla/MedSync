import { NextFunction, Request, Response } from 'express';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { env } from '../config/env';
import { AuthSession } from '../models/AuthSession';
import { User, UserRole } from '../models/User';
import { accessCookieName, getTabSessionId, TAB_SESSION_HEADER } from '../utils/tabSession';

export type AuthenticatedRequest = Request & {
  user?: {
    id: string;
    role: UserRole;
    email: string;
  };
};

export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const tabSessionId = getTabSessionId(req.header(TAB_SESSION_HEADER));
  const token = (tabSessionId ? req.cookies?.[accessCookieName(tabSessionId)] : null)
    || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  let payload: { id: string; familyId: string };
  try {
    const decoded = jwt.verify(token, env.jwtAccessSecret);
    if (typeof decoded === 'string' || typeof decoded.id !== 'string' || typeof decoded.familyId !== 'string') {
      return res.status(401).json({ success: false, message: 'Invalid authentication token.' });
    }
    payload = { id: decoded.id, familyId: decoded.familyId };
  } catch (error) {
    if (error instanceof JsonWebTokenError || error instanceof TokenExpiredError) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }
    return next(error);
  }

  const [user, activeSession] = await Promise.all([
    User.findById(payload.id).select('_id role email isActive'),
    AuthSession.exists({
      familyId: payload.familyId,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    }),
  ]);
  if (!user || !user.isActive || !activeSession) {
    return res.status(401).json({ success: false, message: 'User account is unavailable.' });
  }

  req.user = { id: user.id, role: user.role, email: user.email };
  return next();
};

export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied for this role.' });
    }

    return next();
  };
};
