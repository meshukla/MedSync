import mongoose from 'mongoose';
import { connectDatabase } from '../config/db';
import { User } from '../models/User';
import { hashPassword } from '../utils/password';

const createAdmin = async () => {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PHONE || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    throw new Error('Set ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE and an ADMIN_PASSWORD of at least 8 characters.');
  }

  await connectDatabase();
  if (await User.exists({ role: 'admin' })) {
    throw new Error('An admin account already exists; refusing to create another bootstrap account.');
  }

  const user = await User.create({
    name: ADMIN_NAME,
    email: ADMIN_EMAIL.toLowerCase(),
    phone: ADMIN_PHONE,
    password: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerifiedAt: new Date(),
  });
  console.log(`Created initial administrator: ${user.email}`);
};

const run = async () => {
  try {
    await createAdmin();
  } finally {
    await mongoose.disconnect();
  }
};

void run().catch((error: unknown) => {
    console.error('Unable to create initial administrator:', error);
    process.exitCode = 1;
  });
