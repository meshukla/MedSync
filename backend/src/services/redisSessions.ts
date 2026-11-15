import { redis } from '../config/redis';
import { AuthSession } from '../models/AuthSession';

const ACTIVE_SESSION_CACHE_SECONDS = 60;
const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

const sessionKey = (familyId: string) => `medsync:v1:session-family:${familyId}`;

export const cacheActiveSessionFamily = async (familyId: string, expiresAt: Date) => {
  const ttlSeconds = Math.min(
    ACTIVE_SESSION_CACHE_SECONDS,
    Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
  );
  if (ttlSeconds > 0) await redis.set(sessionKey(familyId), 'active', 'EX', ttlSeconds, 'NX');
};

export const revokeSessionFamilies = async (familyIds: string[]) => {
  if (familyIds.length === 0) return;
  try {
    await Promise.all(familyIds.map((familyId) =>
      redis.set(sessionKey(familyId), 'revoked', 'EX', ACCESS_TOKEN_LIFETIME_SECONDS)));
  } catch (error) {
    const cleanupResults = await Promise.allSettled(familyIds.map((familyId) => redis.del(sessionKey(familyId))));
    cleanupResults.forEach((result) => {
      if (result.status === 'rejected') {
        console.error('Unable to clear a cached active session after a revocation error:', result.reason);
      }
    });
    throw error;
  }
};

export const hasActiveSessionFamily = async (familyId: string) => {
  const key = sessionKey(familyId);
  const cached = await redis.get(key);
  if (cached === 'revoked') return false;
  if (cached === 'active') return true;

  const session = await AuthSession.findOne({
    familyId,
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  }).select('expiresAt').lean();
  if (!session) return false;
  await cacheActiveSessionFamily(familyId, session.expiresAt);
  return await redis.get(key) === 'active';
};
