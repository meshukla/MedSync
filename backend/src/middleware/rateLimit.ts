import { createHash } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';

const incrementBucketsScript = `
  for i = 1, #KEYS do
    local count = redis.call('INCR', KEYS[i])
    if count == 1 then
      redis.call('PEXPIRE', KEYS[i], ARGV[i])
    end
    if count > tonumber(ARGV[#KEYS + i]) then
      local ttl = redis.call('PTTL', KEYS[i])
      return ttl
    end
  end
  return 0
`;

type RateLimitOptions = {
  name: string;
  limit: number;
  windowMs: number;
  identityField?: string;
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export const rateLimit = ({ name, limit, windowMs, identityField }: RateLimitOptions) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const keys = [`medsync:v1:rate-limit:${name}:ip:${hash(req.ip || 'unknown')}`];
    if (identityField) {
      const identity = req.body?.[identityField];
      if (typeof identity === 'string' && identity.trim()) {
        keys.push(`medsync:v1:rate-limit:${name}:identity:${hash(identity.trim().toLowerCase())}`);
      }
    }

    try {
      const ttl = Number(await redis.eval(
        incrementBucketsScript,
        keys.length,
        ...keys,
        ...keys.map(() => windowMs),
        ...keys.map(() => limit),
      ));
      if (ttl > 0) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil(ttl / 1000)));
        return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
