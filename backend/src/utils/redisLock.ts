import { randomUUID } from 'node:crypto';
import { redis } from '../config/redis';

const releaseLockScript = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

export const withRedisLock = async <T>(
  key: string,
  ttlMs: number,
  operation: () => Promise<T>,
): Promise<T | undefined> => {
  const token = randomUUID();
  if (await redis.set(key, token, 'PX', ttlMs, 'NX') !== 'OK') return undefined;
  try {
    return await operation();
  } finally {
    await redis.eval(releaseLockScript, 1, key, token);
  }
};
