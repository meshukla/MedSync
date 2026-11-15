import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: resolve(__dirname, '../../.env') });

const configuredRedisUrl = process.env.REDIS_URL?.trim() || 'redis://localhost:6379';
let parsedRedisUrl: URL;
try {
  parsedRedisUrl = new URL(configuredRedisUrl);
} catch {
  throw new Error('REDIS_URL must contain only a valid redis:// or rediss:// connection URL.');
}
if (
  (parsedRedisUrl.protocol !== 'redis:' && parsedRedisUrl.protocol !== 'rediss:')
  || !parsedRedisUrl.hostname
) {
  throw new Error('REDIS_URL must contain only a valid redis:// or rediss:// connection URL.');
}

const turnUrls = (process.env.TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
const turnSharedSecret = process.env.TURN_SHARED_SECRET || '';
const configuredTurnTtl = process.env.TURN_CREDENTIAL_TTL_SECONDS
  ? Number(process.env.TURN_CREDENTIAL_TTL_SECONDS)
  : 3600;

if (turnUrls.length > 0 && !turnSharedSecret) {
  throw new Error('Set TURN_SHARED_SECRET when TURN_URLS is configured.');
}
if (!Number.isSafeInteger(configuredTurnTtl) || configuredTurnTtl < 300 || configuredTurnTtl > 86400) {
  throw new Error('TURN_CREDENTIAL_TTL_SECONDS must be an integer between 300 and 86400.');
}

export const env = {
  port: Number(process.env.PORT || 5000),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/medsync',
  redisUrl: configuredRedisUrl,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  clinicTimeZone: process.env.CLINIC_TIME_ZONE || 'Asia/Kolkata',
  turnUrls,
  turnSharedSecret,
  turnCredentialTtlSeconds: configuredTurnTtl,
  prescriptionSigningSecret: process.env.PRESCRIPTION_SIGNING_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  brevoApiKey: process.env.BREVO_API_KEY?.trim() || '',
  brevoSenderEmail: process.env.BREVO_SENDER_EMAIL?.trim() || '',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  awsS3Bucket: process.env.AWS_S3_BUCKET || 'medsync-patient-files-2026-609278312725-us-east-1-an',
};

if (env.nodeEnv === 'production' && env.jwtAccessSecret === 'dev-access-secret') {
  throw new Error('Set a unique JWT_ACCESS_SECRET value in production.');
}
if (env.nodeEnv === 'production' && !process.env.PRESCRIPTION_SIGNING_SECRET) {
  throw new Error('Set a unique PRESCRIPTION_SIGNING_SECRET value in production.');
}
