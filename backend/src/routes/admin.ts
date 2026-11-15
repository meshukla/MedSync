import { Router } from 'express';
import { z } from 'zod';
import { Appointment } from '../models/Appointment';
import { Doctor, Department } from '../models/Clinic';
import { PharmacyOrder } from '../models/PharmacyOrder';
import { Payment } from '../models/Payment';
import { AuditLog } from '../models/AuditLog';
import { User, UserRole } from '../models/User';
import { AuthSession } from '../models/AuthSession';
import { requireAuth, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { disconnectSessionFamily, publishAdminEvent, publishRoleEvent, publishUserEvent } from '../realtime/socket';
import { successResponse } from '../utils/response';
import { hashPassword } from '../utils/password';
import { recordAudit } from '../utils/audit';
import { requestFullRefund } from '../services/refunds';
import { notifyRole } from '../services/userNotifications';
import { cacheKeys, invalidateCache } from '../services/redisCache';
import { revokeSessionFamilies } from '../services/redisSessions';

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
  const payments = await Payment.find({ appointmentId: { $in: appointments.map((appointment) => appointment._id) } })
    .select('appointmentId refundStatus status')
    .sort({ createdAt: -1 })
    .lean();
  const paymentSummary = new Map<string, { refundStatus: string; paymentStatus: string }>();
  for (const payment of payments) {
    if (!payment.appointmentId) continue;
    const appointmentId = payment.appointmentId.toString();
    if (!paymentSummary.has(appointmentId)) {
      paymentSummary.set(appointmentId, { refundStatus: payment.refundStatus, paymentStatus: payment.status });
    }
  }

  return res.json(successResponse('Admin dashboard summary loaded.', {
    stats: { totalPatients, totalDoctors, totalAppointments, totalPharmacists, totalDeliveryBoys },
    departments,
    appointments: appointments.map((appointment) => ({
      ...appointment,
      refundStatus: paymentSummary.get(appointment._id.toString())?.refundStatus,
      paymentStatus: paymentSummary.get(appointment._id.toString())?.paymentStatus,
    })),
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
    await invalidateCache(cacheKeys.doctors);
  }
  if (role === 'deliveryBoy') await invalidateCache(cacheKeys.deliveryStaff);

  await recordAudit(req, {
    action: 'admin.staff_created',
    entityType: 'user',
    entityId: user.id,
    details: { role },
  });
  publishAdminEvent('admin.staff-created', { userId: user.id, role });
  if (role === 'doctor' || role === 'pharmacist' || role === 'deliveryBoy') {
    const roleLabel = role === 'deliveryBoy' ? 'delivery boy' : role;
    await notifyRole('admin', {
      event: `staff.${role}.registered`,
      title: `New ${roleLabel} registration`,
      message: `${name} was added as a ${roleLabel}.`,
      metadata: { userId: user.id, role },
      dedupeKey: `staff-registered:${user.id}`,
      email: {
        subject: `New MedSync ${roleLabel} registered`,
        text: `${name} was added as a ${roleLabel}.`,
      },
    });
  }
  if (role === 'doctor') publishRoleEvent('patient', 'doctor.created', { userId: user.id });
  if (role === 'deliveryBoy') publishRoleEvent('pharmacist', 'delivery-staff.updated', { userId: user.id });
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
    await revokeSessionFamilies(activeFamilies);
    for (const familyId of activeFamilies) disconnectSessionFamily(familyId);
  }
  if (user.role === 'doctor') await invalidateCache(cacheKeys.doctors);
  if (user.role === 'deliveryBoy') await invalidateCache(cacheKeys.deliveryStaff);

  await recordAudit(req, {
    action: 'admin.user_status_updated',
    entityType: 'user',
    entityId: user.id,
    details: { isActive: user.isActive },
  });
  publishAdminEvent('admin.user-status', { userId: user.id, role: user.role, isActive: user.isActive });
  if (user.role === 'doctor') publishRoleEvent('patient', 'doctor.status-updated', { userId: user.id });
  if (user.role === 'deliveryBoy') publishRoleEvent('pharmacist', 'delivery-staff.updated', { userId: user.id });
  return res.json(successResponse('Account status updated.', user));
});

router.get('/audit-logs', requireAuth, requireRole('admin'), async (req, res) => {
  const parsedLimit = Number(req.query.limit);
  const limit = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 100;
  const logs = await AuditLog.find()
    .populate('actorId', 'name role')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return res.json(successResponse('Audit logs loaded.', logs));
});

const departmentSchema = z.object({
  name: z.string().trim().min(2).max(100),
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().trim().min(2).max(500),
});

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

router.post('/departments', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = departmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a valid department name, code, and description.' });
  }
  try {
    const department = await Department.create(parsed.data);
    await invalidateCache(cacheKeys.departments);
    await recordAudit(req, {
      action: 'admin.department_created',
      entityType: 'department',
      entityId: department.id,
      details: { name: department.name, code: department.code },
    });
    publishAdminEvent('admin.department-created', { departmentId: department.id });
    publishRoleEvent('patient', 'admin.departments-updated', { departmentId: department.id });
    return res.status(201).json(successResponse('Department created.', department));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ success: false, message: 'A department with that name or code already exists.' });
    }
    throw error;
  }
});

router.patch('/departments/:id', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = departmentSchema.partial().safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data || {}).length === 0) {
    return res.status(400).json({ success: false, message: 'Provide valid department fields to update.' });
  }
  try {
    const department = await Department.findByIdAndUpdate(
      req.params.id,
      { $set: parsed.data },
      { new: true, runValidators: true },
    );
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }
    await invalidateCache(cacheKeys.departments);
    await recordAudit(req, {
      action: 'admin.department_updated',
      entityType: 'department',
      entityId: department.id,
      details: parsed.data,
    });
    publishAdminEvent('admin.department-updated', { departmentId: department.id });
    publishRoleEvent('patient', 'admin.departments-updated', { departmentId: department.id });
    return res.json(successResponse('Department updated.', department));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ success: false, message: 'A department with that name or code already exists.' });
    }
    throw error;
  }
});

router.delete('/departments/:id', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const department = await Department.findById(req.params.id);
  if (!department) {
    return res.status(404).json({ success: false, message: 'Department not found.' });
  }
  if (await Doctor.exists({ department: department.name })) {
    return res.status(409).json({ success: false, message: 'Reassign doctors before deleting this department.' });
  }
  await Department.deleteOne({ _id: department._id });
  await invalidateCache(cacheKeys.departments);
  await recordAudit(req, {
    action: 'admin.department_deleted',
    entityType: 'department',
    entityId: department.id,
    details: { name: department.name, code: department.code },
  });
  publishAdminEvent('admin.department-deleted', { departmentId: department.id });
  publishRoleEvent('patient', 'admin.departments-updated', { departmentId: department.id });
  return res.json(successResponse('Department deleted.'));
});

const refundSchema = z.object({ reason: z.string().trim().min(5).max(500) });

router.post('/appointments/:id/refund', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Provide a reason for the refund exception.' });
  }
  const appointment = await Appointment.findOne({
    _id: req.params.id,
    status: { $in: ['CONFIRMED', 'CANCELLED'] },
  });
  if (!appointment) {
    return res.status(404).json({ success: false, message: 'Eligible appointment not found.' });
  }
  const payment = await Payment.findOne({
    appointmentId: appointment._id,
    patientId: appointment.patientId,
    status: 'CAPTURED',
  });
  if (!payment) {
    return res.status(409).json({ success: false, message: 'No captured consultation payment was found.' });
  }
  const result = await requestFullRefund(payment, `admin_exception: ${parsed.data.reason}`);
  if (!result.success) {
    return res.status(409).json({ success: false, message: result.message });
  }
  const cancelledAppointment = appointment.status === 'CONFIRMED'
    ? await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: 'CONFIRMED' },
      { $set: { status: 'CANCELLED' } },
      { new: true },
    )
    : appointment;
  if (!cancelledAppointment) {
    return res.status(409).json({ success: false, message: 'Refund requested, but the appointment status changed. Review the audit log.' });
  }
  await recordAudit(req, {
    action: 'admin.appointment_refund_requested',
    entityType: 'payment',
    entityId: payment.id,
    details: {
      appointmentId: appointment.id,
      amountPaise: payment.amountPaise,
      reason: parsed.data.reason,
      refundId: result.payment.refundId,
    },
  });
  const event = { appointmentId: appointment.id, status: cancelledAppointment.status, refundStatus: result.payment.refundStatus };
  publishAdminEvent('appointment.refund-status', event);
  publishUserEvent(appointment.patientId.toString(), 'appointment.refund-status', event);
  return res.json(successResponse('Full refund requested for the appointment.', {
    appointment: cancelledAppointment,
    refundStatus: result.payment.refundStatus,
  }));
});

export default router;
