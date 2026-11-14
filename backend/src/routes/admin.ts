import { Router } from 'express';
import { z } from 'zod';
import { Appointment } from '../models/Appointment';
import { Doctor, Department } from '../models/Clinic';
import { PharmacyOrder } from '../models/PharmacyOrder';
import { User, UserRole } from '../models/User';
import { AuthSession } from '../models/AuthSession';
import { requireAuth, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { disconnectSessionFamily } from '../realtime/socket';
import { successResponse } from '../utils/response';
import { hashPassword } from '../utils/password';

const router = Router();

router.get('/dashboard', requireAuth, requireRole('admin'), async (_req, res) => {
  const [totalPatients, totalDoctors, totalAppointments, totalPharmacists, totalDeliveryBoys, departments, appointments, pharmacyOrders] = await Promise.all([
    User.countDocuments({ role: 'patient', isActive: true }),
    Doctor.countDocuments(),
    Appointment.countDocuments(),
    User.countDocuments({ role: 'pharmacist', isActive: true }),
    User.countDocuments({ role: 'deliveryBoy', isActive: true }),
    Department.find().sort({ name: 1 }).lean(),
    Appointment.find().sort({ createdAt: -1 }).limit(10).lean(),
    PharmacyOrder.find().sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  return res.json(successResponse('Admin dashboard summary loaded.', {
    stats: { totalPatients, totalDoctors, totalAppointments, totalPharmacists, totalDeliveryBoys },
    departments,
    appointments,
    pharmacyOrders,
  }));
});

router.get('/users', requireAuth, requireRole('admin'), async (_req, res) => {
  const users = await User.find().select('_id name email phone role isActive createdAt').sort({ createdAt: -1 }).lean();
  return res.json(successResponse('Users loaded.', users));
});

const createUserSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  phone: z.string().trim().min(10),
  password: z.string().min(8),
  role: z.enum(['doctor', 'admin', 'pharmacist', 'deliveryBoy']),
  specialization: z.string().trim().min(2).optional(),
  department: z.string().trim().min(2).optional(),
  fee: z.number().min(0).optional(),
});

router.post('/users', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid staff account payload.', details: parsed.error.flatten() });
  }

  const { name, email, phone, password, role, specialization, department, fee } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  if (await User.exists({ $or: [{ email: normalizedEmail }, { phone }] })) {
    return res.status(409).json({ success: false, message: 'An account with that email or phone already exists.' });
  }

  const user = await User.create({
    name,
    email: normalizedEmail,
    phone,
    password: await hashPassword(password),
    role: role as UserRole,
    emailVerifiedAt: new Date(),
  });
  if (role === 'doctor') {
    try {
      await Doctor.create({
        userId: user.id,
        name,
        specialization: specialization || 'General Practitioner',
        department: department || 'General Medicine',
        fee: fee ?? 1200,
      });
    } catch (error) {
      await User.deleteOne({ _id: user.id });
      throw error;
    }
  }

  return res.status(201).json(successResponse('Staff account created.', {
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role },
  }));
});

const activeSchema = z.object({ isActive: z.boolean() });

router.patch('/users/:id/status', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = activeSchema.safeParse(req.body);
  if (!parsed.success || req.params.id === req.user?.id) {
    return res.status(400).json({ success: false, message: 'Invalid account status update.' });
  }

  const user = await User.findByIdAndUpdate(req.params.id, { $set: { isActive: parsed.data.isActive } }, { new: true })
    .select('_id name email phone role isActive');
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  if (!parsed.data.isActive) {
    const activeFamilies = await AuthSession.find({ userId: user._id, revokedAt: { $exists: false } }).distinct('familyId');
    await AuthSession.updateMany({ familyId: { $in: activeFamilies }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    for (const familyId of activeFamilies) disconnectSessionFamily(familyId);
  }

  return res.json(successResponse('Account status updated.', user));
});

export default router;
