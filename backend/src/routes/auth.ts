import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { AuthSession } from '../models/AuthSession';
import { User } from '../models/User';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { sendVerificationEmail } from '../services/email';
import {
  beginOtpAttempt,
  consumeOtp,
  invalidateOtp,
  otpRateLimitRedisKey,
  otpRedisKey,
  storeOtp,
} from '../services/redisOtp';
import { cacheActiveSessionFamily, revokeSessionFamilies } from '../services/redisSessions';
import { disconnectSessionFamily, publishAdminEvent } from '../realtime/socket';
import { accessCookieName, getTabSessionId, refreshCookieName, TAB_SESSION_HEADER } from '../utils/tabSession';
import { successResponse } from '../utils/response';
import { hashPassword } from '../utils/password';
import { notifyRole, notifyUsers } from '../services/userNotifications';

const router = Router();

const OTP_LIFETIME_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_SEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_SENDS_PER_WINDOW = 5;
const OTP_MAX_ATTEMPTS = 5;
const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

class EmailDeliveryError extends Error {}

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

const registerSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  phone: z.string().trim().min(10),
  deliveryAddress: z.string().trim().max(500).optional(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  role: z.enum(['patient', 'doctor', 'admin', 'pharmacist', 'deliveryBoy']).optional(),
});

const emailSchema = z.object({ email: z.string().trim().email() });
const verifyOtpSchema = z.object({
  email: z.string().trim().email(),
  code: z.string().regex(/^\d{6}$/),
});

const cookieOptions = (maxAge: number, path: string) => ({
  httpOnly: true,
  secure: env.nodeEnv === 'production',
  sameSite: 'strict' as const,
  maxAge,
  path,
});

const setAuthCookies = (
  res: Response,
  tabSessionId: string,
  accessToken: string,
  refreshToken: string,
  refreshMaxAge = REFRESH_TOKEN_LIFETIME_MS,
) => {
  res.cookie(accessCookieName(tabSessionId), accessToken, cookieOptions(ACCESS_TOKEN_LIFETIME_MS, '/'));
  res.cookie(refreshCookieName(tabSessionId), refreshToken, cookieOptions(refreshMaxAge, '/api/v1/auth'));
};

const clearAuthCookies = (res: Response, tabSessionId?: string) => {
  if (tabSessionId) {
    res.clearCookie(accessCookieName(tabSessionId), cookieOptions(0, '/'));
    res.clearCookie(refreshCookieName(tabSessionId), cookieOptions(0, '/api/v1/auth'));
  }
};

const createAccessToken = (userId: string, familyId: string) =>
  jwt.sign({ id: userId, familyId }, env.jwtAccessSecret, { expiresIn: '15m' });
const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');
const hashOtp = (email: string, code: string) =>
  createHmac('sha256', env.jwtAccessSecret).update(`${email}:${code}`).digest('hex');

const otpSendRateLimit = rateLimit({
  name: 'otp-send',
  limit: 3,
  windowMs: 10 * 60 * 1000,
  identityField: 'email',
});

const sendOtp = async (email: string) => {
  const now = Date.now();
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const codeHash = hashOtp(email, code);
  const key = otpRedisKey(email);
  const stored = await storeOtp({
    key,
    rateKey: otpRateLimitRedisKey(email),
    codeHash,
    now,
    expiresAt: now + OTP_LIFETIME_MS,
    cooldownMs: OTP_RESEND_COOLDOWN_MS,
    windowMs: OTP_SEND_WINDOW_MS,
    maxSends: OTP_MAX_SENDS_PER_WINDOW,
    ttlSeconds: Math.ceil(OTP_LIFETIME_MS / 1000),
    rateTtlSeconds: Math.ceil(OTP_SEND_WINDOW_MS / 1000),
  });
  if (stored !== 1) return false;

  try {
    await sendVerificationEmail(email, code);
  } catch (error) {
    console.error('Verification email delivery failed:', error instanceof Error ? error.message : 'Unknown email error.');
    await invalidateOtp(key, codeHash);
    throw new EmailDeliveryError('Verification email delivery failed.');
  }
  return true;
};

const createSession = async (userId: string, familyId: string, expiresAt: Date) => {
  const token = randomBytes(48).toString('base64url');
  await AuthSession.create({
    userId,
    familyId,
    tokenHash: hashRefreshToken(token),
    expiresAt,
  });
  return token;
};

const issueSession = async (res: Response, userId: string, tabSessionId: string) => {
  const now = new Date();
  const familyId = randomUUID();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS);
  const refreshToken = await createSession(userId, familyId, expiresAt);
  await cacheActiveSessionFamily(familyId, expiresAt);
  setAuthCookies(res, tabSessionId, createAccessToken(userId, familyId), refreshToken);
};

router.post('/register', otpSendRateLimit, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid registration payload.', details: parsed.error.flatten() });
  }

  const { name, email, phone, deliveryAddress, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const existingUser = await User.findOne({ $or: [{ email: normalizedEmail }, { phone }] })
    .select('_id email role emailVerifiedAt');
  if (existingUser) {
    const canResumeVerification = existingUser.role === 'patient'
      && existingUser.email === normalizedEmail
      && !existingUser.emailVerifiedAt;
    return res.status(409).json({
      success: false,
      message: canResumeVerification
        ? 'This account still needs email verification. Request a new code.'
        : 'An account with that email or phone already exists.',
      data: canResumeVerification ? { email: normalizedEmail } : undefined,
    });
  }

  let user;
  try {
    user = await User.create({
      name,
      email: normalizedEmail,
      phone,
      deliveryAddress,
      password: await hashPassword(password),
      role: 'patient',
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ success: false, message: 'An account with that email or phone already exists.' });
    }
    throw error;
  }

  publishAdminEvent('patient.registered', { userId: user.id });
  await notifyRole('admin', {
    event: 'patient.registered',
    title: 'New patient registration',
    message: `Patient ${user.name} registered and is awaiting email verification.`,
    metadata: { userId: user.id },
    dedupeKey: `patient-registered:${user.id}`,
  });

  try {
    const sent = await sendOtp(normalizedEmail);
    if (!sent) {
      return res.status(429).json({
        success: false,
        message: 'Please wait before requesting another verification code.',
        data: { email: normalizedEmail },
      });
    }
  } catch (error) {
    if (!(error instanceof EmailDeliveryError)) throw error;
    return res.status(503).json({
      success: false,
      message: 'The verification email could not be sent. Please request another code shortly.',
      data: { email: normalizedEmail },
    });
  }

  return res.status(201).json(successResponse('Verification code sent. Verify your email before signing in.', {
    email: user.email,
  }));
});

router.post('/otp/resend', otpSendRateLimit, async (req, res) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  }

  const email = parsed.data.email.toLowerCase();
  const user = await User.findOne({ email, role: 'patient' }).select('_id emailVerifiedAt');
  if (!user || user.emailVerifiedAt) {
    return res.status(202).json(successResponse('If the account needs verification, a code has been sent.'));
  }

  try {
    const sent = await sendOtp(email);
    if (!sent) {
      return res.status(429).json({ success: false, message: 'Please wait before requesting another verification code.' });
    }
  } catch (error) {
    if (!(error instanceof EmailDeliveryError)) throw error;
    return res.status(503).json({ success: false, message: 'The verification email could not be sent. Please try again later.' });
  }

  return res.status(202).json(successResponse('If the account needs verification, a code has been sent.'));
});

router.post('/otp/verify', rateLimit({
  name: 'otp-verify',
  limit: 10,
  windowMs: 10 * 60 * 1000,
  identityField: 'email',
}), async (req, res) => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a valid email and six-digit code.' });
  }

  const email = parsed.data.email.toLowerCase();
  const now = Date.now();
  const key = otpRedisKey(email);
  const codeHash = await beginOtpAttempt(key, now, OTP_MAX_ATTEMPTS);
  if (!codeHash) {
    return res.status(400).json({ success: false, message: 'The verification code is invalid or expired.' });
  }

  const submittedHash = Buffer.from(hashOtp(email, parsed.data.code), 'hex');
  const storedHash = Buffer.from(codeHash, 'hex');
  if (!timingSafeEqual(submittedHash, storedHash)) {
    return res.status(400).json({ success: false, message: 'The verification code is invalid or expired.' });
  }

  if (!await consumeOtp(key, codeHash, now, OTP_MAX_ATTEMPTS)) {
    return res.status(400).json({ success: false, message: 'The verification code is invalid or expired.' });
  }

  const user = await User.findOneAndUpdate(
    { email, role: 'patient', emailVerifiedAt: { $exists: false } },
    { $set: { emailVerifiedAt: new Date(now) } },
    { new: true },
  );
  if (!user) {
    const alreadyVerified = await User.exists({ email, role: 'patient', emailVerifiedAt: { $exists: true } });
    if (!alreadyVerified) {
      return res.status(404).json({ success: false, message: 'Patient account not found.' });
    }
  } else {
    publishAdminEvent('patient.email-verified', { userId: user.id });
    await notifyUsers([user.id], {
      event: 'registration.successful',
      title: 'Registration successful',
      message: 'Your MedSync account is ready to use.',
      metadata: { userId: user.id },
      dedupeKey: `registration-success:${user.id}`,
      email: {
        subject: 'Welcome to MedSync',
        text: 'Your MedSync registration is complete. You can now sign in to manage your appointments and prescriptions.',
      },
    });
  }

  return res.json(successResponse('Email verified. You can now sign in.'));
});

router.post('/login', rateLimit({
  name: 'login',
  limit: 5,
  windowMs: 15 * 60 * 1000,
  identityField: 'email',
}), async (req, res) => {
  const tabSessionId = getTabSessionId(req.header(TAB_SESSION_HEADER));
  if (!tabSessionId) {
    return res.status(400).json({ success: false, message: 'A valid browser-tab session ID is required. Reload the page and try again.' });
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a valid email and password.' });
  }

  const user = await User.findOne({ email: parsed.data.email.toLowerCase() }).select('+password');
  if (!user || !user.isActive || !(await bcrypt.compare(parsed.data.password, user.password))) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }
  if (parsed.data.role && user.role !== parsed.data.role) {
    return res.status(403).json({ success: false, message: 'These credentials do not match the selected role.' });
  }
  if (user.role === 'patient' && !user.emailVerifiedAt) {
    return res.status(403).json({ success: false, message: 'Verify your email before signing in.' });
  }

  await issueSession(res, user.id, tabSessionId);
  return res.json(successResponse('Login successful.', {
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, deliveryAddress: user.deliveryAddress, role: user.role },
  }));
});

router.post('/refresh', async (req, res) => {
  const tabSessionId = getTabSessionId(req.header(TAB_SESSION_HEADER));
  if (!tabSessionId) {
    return res.status(400).json({ success: false, message: 'A valid browser-tab session ID is required. Reload the page and sign in again.' });
  }
  const refreshToken = req.cookies?.[refreshCookieName(tabSessionId)] as string | undefined;
  if (!refreshToken) {
    clearAuthCookies(res, tabSessionId);
    return res.status(401).json({ success: false, message: 'Refresh session is unavailable.' });
  }

  const tokenHash = hashRefreshToken(refreshToken);
  const session = await AuthSession.findOne({ tokenHash }).select('+tokenHash');
  if (!session) {
    clearAuthCookies(res, tabSessionId);
    return res.status(401).json({ success: false, message: 'Refresh session is invalid or expired.' });
  }

  if (session.revokedAt) {
    await AuthSession.updateMany({ familyId: session.familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await revokeSessionFamilies([session.familyId]);
    disconnectSessionFamily(session.familyId);
    clearAuthCookies(res, tabSessionId);
    return res.status(401).json({ success: false, message: 'Refresh session reuse detected. Please sign in again.' });
  }

  const now = new Date();
  if (session.expiresAt <= now) {
    clearAuthCookies(res, tabSessionId);
    return res.status(401).json({ success: false, message: 'Refresh session is invalid or expired.' });
  }

  const user = await User.findById(session.userId).select('_id isActive');
  if (!user || !user.isActive) {
    await AuthSession.updateMany({ familyId: session.familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
    await revokeSessionFamilies([session.familyId]);
    disconnectSessionFamily(session.familyId);
    clearAuthCookies(res, tabSessionId);
    return res.status(401).json({ success: false, message: 'User account is unavailable.' });
  }

  const nextToken = randomBytes(48).toString('base64url');
  const nextHash = hashRefreshToken(nextToken);
  await AuthSession.create({
    userId: user.id,
    familyId: session.familyId,
    tokenHash: nextHash,
    expiresAt: session.expiresAt,
  });
  const rotated = await AuthSession.findOneAndUpdate(
    { _id: session._id, revokedAt: { $exists: false }, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, replacedByHash: nextHash } },
  );
  if (!rotated) {
    await AuthSession.deleteOne({ tokenHash: nextHash });
    await AuthSession.updateMany({ familyId: session.familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
    await revokeSessionFamilies([session.familyId]);
    disconnectSessionFamily(session.familyId);
    clearAuthCookies(res, tabSessionId);
    return res.status(401).json({ success: false, message: 'Refresh session was already used. Please sign in again.' });
  }

  await cacheActiveSessionFamily(session.familyId, session.expiresAt);
  setAuthCookies(
    res,
    tabSessionId,
    createAccessToken(user.id, session.familyId),
    nextToken,
    Math.max(session.expiresAt.getTime() - now.getTime(), 0),
  );
  return res.json(successResponse('Session refreshed.'));
});

router.post('/logout', async (req, res) => {
  const tabSessionId = getTabSessionId(req.header(TAB_SESSION_HEADER));
  const refreshToken = tabSessionId
    ? req.cookies?.[refreshCookieName(tabSessionId)] as string | undefined
    : undefined;
  if (refreshToken) {
    const session = await AuthSession.findOne({ tokenHash: hashRefreshToken(refreshToken) });
    if (session && !session.revokedAt) {
      await AuthSession.updateMany({ familyId: session.familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
      await revokeSessionFamilies([session.familyId]);
      disconnectSessionFamily(session.familyId);
    }
  }

  clearAuthCookies(res, tabSessionId);
  return res.json(successResponse('Logged out.'));
});

router.get('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  const user = await User.findById(req.user?.id).select('_id name email phone deliveryAddress role');
  if (!user) {
    return res.status(404).json({ success: false, message: 'User profile not found.' });
  }

  return res.json(successResponse('Profile loaded.', {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    deliveryAddress: user.deliveryAddress,
    role: user.role,
  }));
});

export default router;
