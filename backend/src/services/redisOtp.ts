import { createHash } from 'node:crypto';
import { redis } from '../config/redis';

const storeOtpScript = `
  local sentAt = tonumber(redis.call('HGET', KEYS[2], 'sentAt') or '0')
  local now = tonumber(ARGV[1])
  if sentAt > 0 and now - sentAt < tonumber(ARGV[4]) then
    return 0
  end

  local windowStartedAt = tonumber(redis.call('HGET', KEYS[2], 'windowStartedAt') or '0')
  local sendCount = tonumber(redis.call('HGET', KEYS[2], 'sendCount') or '0')
  if windowStartedAt == 0 or now - windowStartedAt >= tonumber(ARGV[5]) then
    windowStartedAt = now
    sendCount = 0
  end
  if sendCount >= tonumber(ARGV[6]) then
    return -1
  end

  redis.call('HSET', KEYS[1],
    'codeHash', ARGV[3],
    'expiresAt', ARGV[2],
    'attempts', 0)
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[7]))
  redis.call('HSET', KEYS[2],
    'sentAt', now,
    'windowStartedAt', windowStartedAt,
    'sendCount', sendCount + 1)
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[8]))
  return 1
`;

const beginOtpAttemptScript = `
  if redis.call('EXISTS', KEYS[1]) == 0 then return '' end
  if tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0') <= tonumber(ARGV[1]) then return '' end
  local attempts = tonumber(redis.call('HGET', KEYS[1], 'attempts') or '0')
  if attempts >= tonumber(ARGV[2]) then return '' end
  redis.call('HINCRBY', KEYS[1], 'attempts', 1)
  return redis.call('HGET', KEYS[1], 'codeHash') or ''
`;

const consumeOtpScript = `
  if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
  if redis.call('HGET', KEYS[1], 'codeHash') ~= ARGV[1] then return 0 end
  if tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0') <= tonumber(ARGV[2]) then return 0 end
  if tonumber(redis.call('HGET', KEYS[1], 'attempts') or '0') > tonumber(ARGV[3]) then return 0 end
  redis.call('DEL', KEYS[1])
  return 1
`;

const invalidateOtpScript = `
  if redis.call('HGET', KEYS[1], 'codeHash') == ARGV[1] then
    redis.call('DEL', KEYS[1])
    return 1
  end
  return 0
`;

export const otpRedisKey = (email: string) =>
  `medsync:v1:otp:email-verification:${createHash('sha256').update(email).digest('hex')}`;

export const otpRateLimitRedisKey = (email: string) =>
  `${otpRedisKey(email)}:rate`;

export const storeOtp = async (input: {
  key: string;
  rateKey: string;
  codeHash: string;
  now: number;
  expiresAt: number;
  cooldownMs: number;
  windowMs: number;
  maxSends: number;
  ttlSeconds: number;
  rateTtlSeconds: number;
}) => Number(await redis.eval(
  storeOtpScript,
  2,
  input.key,
  input.rateKey,
  input.now,
  input.expiresAt,
  input.codeHash,
  input.cooldownMs,
  input.windowMs,
  input.maxSends,
  input.ttlSeconds,
  input.rateTtlSeconds,
));

export const beginOtpAttempt = async (key: string, now: number, maxAttempts: number) =>
  String(await redis.eval(beginOtpAttemptScript, 1, key, now, maxAttempts));

export const consumeOtp = async (key: string, codeHash: string, now: number, maxAttempts: number) =>
  Number(await redis.eval(consumeOtpScript, 1, key, codeHash, now, maxAttempts)) === 1;

export const invalidateOtp = async (key: string, codeHash: string) =>
  Number(await redis.eval(invalidateOtpScript, 1, key, codeHash)) === 1;
