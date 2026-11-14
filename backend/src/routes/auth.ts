import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { AuthSession } from '../models/AuthSession';
import { OtpRecord } from '../models/OtpRecord';
import { User } from '../models/User';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { sendVerificationEmail } from '../services/email';
import { disconnectSessionFamily } from '../realtime/socket';
import { successResponse } from '../utils/response';
import { hashPassword } from '../utils/password';

const router = Router();

const OTP_LIFETIME_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_SEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_SENDS_PER_WINDOW = 5;
const OTP_MAX_ATTEMPTS = 5;
const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_COOKIE = 'medsyncAccessToken';
const REFRESH_COOKIE = 'medsyncRefreshToken';
const OTP_PURPOSE = 'EMAIL_VERIFICATION' as const;

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

const setAuthCookies = (res: Response, accessToken: string, refreshToken: string, refreshMaxAge = REFRESH_TOKEN_LIFETIME_MS) => {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_TOKEN_LIFETIME_MS, '/'));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(refreshMaxAge, '/api/v1/auth'));
};

const clearAuthCookies = (res: Response) => {
  res.clearCookie(ACCESS_COOKIE, cookieOptions(0, '/'));
  res.clearCookie(REFRESH_COOKIE, cookieOptions(0, '/api/v1/auth'));
};

const createAccessToken = (userId: string, familyId: string) =>
  jwt.sign({ id: userId, familyId }, env.jwtAccessSecret, { expiresIn: '15m' });
const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');
const hashOtp = (email: string, code: string) =>
  createHmac('sha256', env.jwtAccessSecret).update(`${email}:${code}`).digest('hex');

const sendOtp = async (email: string) => {
  const now = new Date();
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const existing = await OtpRecord.findOne({ email, purpose: OTP_PURPOSE });

  if (existing && now.getTime() - existing.sentAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    return false;
  }

  const windowExpired = !existing || now.getTime() - existing.windowStartedAt.getTime() >= OTP_SEND_WINDOW_MS;
  if (existing && !windowExpired && existing.sendCount >= OTP_MAX_SENDS_PER_WINDOW) {
    return false;
  }

  if (existing) {
    const updated = await OtpRecord.updateOne(
      {
        _id: existing._id,
        sendCount: existing.sendCount,
        sentAt: existing.sentAt,
        consumedAt: existing.consumedAt ?? null,
      },
      {
        $set: {
          codeHash: hashOtp(email, code),
          expiresAt: new Date(now.getTime() + OTP_LIFETIME_MS),
          attempts: 0,
          sentAt: now,
          windowStartedAt: windowExpired ? now : existing.windowStartedAt,
          sendCount: windowExpired ? 1 : existing.sendCount + 1,
          consumedAt: null,
        },
      },
    );
    if (updated.modifiedCount !== 1) return false;
  } else {
    try {
      await OtpRecord.create({
        email,
        purpose: OTP_PURPOSE,
        codeHash: hashOtp(email, code),
        expiresAt: new Date(now.getTime() + OTP_LIFETIME_MS),
        attempts: 0,
        sentAt: now,
        windowStartedAt: now,
        sendCount: 1,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  try {
    await sendVerificationEmail(email, code);
  } catch (error) {
    console.error('Verification email delivery failed:', error instanceof Error ? error.message : 'Unknown email error.');
    await OtpRecord.deleteOne({ email, purpose: OTP_PURPOSE, codeHash: hashOtp(email, code) });
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

const issueSession = async (res: Response, userId: string) => {
  const now = new Date();
  const familyId = randomUUID();
  const refreshToken = await createSession(
    userId,
    familyId,
    new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
  );
  setAuthCookies(res, createAccessToken(userId, familyId), refreshToken);
};

router.post('/register', async (req, res) => {
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

router.post('/otp/resend', async (req, res) => {
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

router.post('/otp/verify', async (req, res) => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a valid email and six-digit code.' });
  }

  const email = parsed.data.email.toLowerCase();
  const now = new Date();
  const otp = await OtpRecord.findOneAndUpdate(
    {
      email,
      purpose: OTP_PURPOSE,
      expiresAt: { $gt: now },
      attempts: { $lt: OTP_MAX_ATTEMPTS },
      consumedAt: null,
    },
    { $inc: { attempts: 1 } },
    { new: true },
  ).select('+codeHash');

  if (!otp) {
    return res.status(400).json({ success: false, message: 'The verification code is invalid or expired.' });
  }

  const submittedHash = Buffer.from(hashOtp(email, parsed.data.code), 'hex');
  const storedHash = Buffer.from(otp.codeHash, 'hex');
  if (!timingSafeEqual(submittedHash, storedHash)) {
    return res.status(400).json({ success: false, message: 'The verification code is invalid or expired.' });
  }

  const consumed = await OtpRecord.updateOne(
    { _id: otp._id, attempts: otp.attempts, consumedAt: null },
    { $set: { consumedAt: now } },
  );
  if (consumed.modifiedCount !== 1) {
    return res.status(400).json({ success: false, message: 'The verification code is invalid or expired.' });
  }

  const user = await User.findOneAndUpdate(
    { email, role: 'patient', emailVerifiedAt: { $exists: false } },
    { $set: { emailVerifiedAt: now } },
    { new: true },
  );
  if (!user) {
    const alreadyVerified = await User.exists({ email, role: 'patient', emailVerifiedAt: { $exists: true } });
    if (!alreadyVerified) {
      return res.status(404).json({ success: false, message: 'Patient account not found.' });
    }
  }

  return res.json(successResponse('Email verified. You can now sign in.'));
});

router.post('/login', async (req, res) => {
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

  await issueSession(res, user.id);
  return res.json(successResponse('Login successful.', {
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, deliveryAddress: user.deliveryAddress, role: user.role },
  }));
});

router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!refreshToken) {
    clearAuthCookies(res);
    return res.status(401).json({ success: false, message: 'Refresh session is unavailable.' });
  }

  const tokenHash = hashRefreshToken(refreshToken);
  const session = await AuthSession.findOne({ tokenHash }).select('+tokenHash');
  if (!session) {
    clearAuthCookies(res);
    return res.status(401).json({ success: false, message: 'Refresh session is invalid or expired.' });
  }

  if (session.revokedAt) {
    await AuthSession.updateMany({ familyId: session.familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    disconnectSessionFamily(session.familyId);
    clearAuthCookies(res);
    return res.status(401).json({ success: false, message: 'Refresh session reuse detected. Please sign in again.' });
  }

  const now = new Date();
  if (session.expiresAt <= now) {
    clearAuthCookies(res);
    return res.status(401).json({ success: false, message: 'Refresh session is invalid or expired.' });
  }

  const user = await User.findById(session.userId).select('_id isActive');
  if (!user || !user.isActive) {
    await AuthSession.updateMany({ familyId: session.familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
    disconnectSessionFamily(session.familyId);
    clearAuthCookies(res);
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
    disconnectSessionFamily(session.familyId);
    clearAuthCookies(res);
    return res.status(401).json({ success: false, message: 'Refresh session was already used. Please sign in again.' });
  }

  setAuthCookies(
    res,
    createAccessToken(user.id, session.familyId),
    nextToken,
    Math.max(session.expiresAt.getTime() - now.getTime(), 0),
  );
  return res.json(successResponse('Session refreshed.'));
});

router.post('/logout', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (refreshToken) {
    const session = await AuthSession.findOne({ tokenHash: hashRefreshToken(refreshToken) });
    if (session && !session.revokedAt) {
      await AuthSession.updateMany({ familyId: session.familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
      disconnectSessionFamily(session.familyId);
    }
  }

  clearAuthCookies(res);
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
