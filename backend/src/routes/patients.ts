import { Router } from 'express';
import { z } from 'zod';
import { Appointment } from '../models/Appointment';
import { Department, Doctor } from '../models/Clinic';
import { Payment } from '../models/Payment';
import { PharmacyOrder } from '../models/PharmacyOrder';
import { User } from '../models/User';
import { requireAuth, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { env } from '../config/env';
import { getRazorpayClient, PaymentConfigurationError } from '../services/razorpay';
import { publishAdminEvent, publishUserEvent } from '../realtime/socket';
import { successResponse } from '../utils/response';
import { clinicDateTimeToDate, getClinicDate, getClinicSlots, isValidClinicDate } from '../utils/clinicSchedule';

const router = Router();

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

router.get('/departments', requireAuth, async (_req, res) => {
  const departments = await Department.find().sort({ name: 1 }).lean();
  return res.json(successResponse('Departments fetched.', departments));
});

router.get('/doctors', requireAuth, async (_req, res) => {
  const doctors = await Doctor.find().select('_id name specialization department fee').sort({ name: 1 }).lean();
  return res.json(successResponse('Doctors fetched.', doctors));
});

router.get('/doctors/:doctorId/slots', requireAuth, requireRole('patient'), async (req, res) => {
  const doctorId = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.doctorId);
  const date = z.string().safeParse(req.query.date);
  if (!doctorId.success || !date.success || !isValidClinicDate(date.data)) {
    return res.status(400).json({ success: false, message: 'Select a valid appointment date.' });
  }
  if (date.data < getClinicDate(new Date())) {
    return res.status(400).json({ success: false, message: 'Appointment dates must be today or later.' });
  }
  if (!await Doctor.exists({ _id: doctorId.data })) {
    return res.status(404).json({ success: false, message: 'Doctor not found.' });
  }

  const slots = getClinicSlots(date.data);
  const appointments = slots.length
    ? await Appointment.find({ doctorId: doctorId.data, slot: { $in: slots.map(({ slot }) => slot) } })
      .select('slot')
      .lean()
    : [];
  const bookedTimes = new Set(appointments.map(({ slot }) => slot.getTime()));
  return res.json(successResponse('Doctor slots loaded.', slots
    .filter(({ slot }) => !bookedTimes.has(slot.getTime()))
    .map(({ time }) => time)));
});

router.get('/appointments', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const appointments = await Appointment.find({ patientId: req.user?.id }).sort({ slot: 1 }).lean();
  const payments = await Payment.find({
    patientId: req.user?.id,
    appointmentId: { $in: appointments.map((appointment) => appointment._id) },
  }).sort({ createdAt: -1 }).lean();
  const latestPayment = new Map<string, (typeof payments)[number]>();
  for (const payment of payments) {
    if (!latestPayment.has(payment.appointmentId.toString())) latestPayment.set(payment.appointmentId.toString(), payment);
  }
  return res.json(successResponse('Appointments loaded.', appointments.map((appointment) => {
    const payment = latestPayment.get(appointment._id.toString());
    return {
      ...appointment,
      checkout: payment && appointment.status === 'PAYMENT_PENDING'
        ? { keyId: env.razorpayKeyId, orderId: payment.providerOrderId, amount: payment.amountPaise, currency: payment.currency }
        : undefined,
    };
  })));
});

const appointmentSchema = z.object({
  doctorId: z.string().regex(/^[a-f\d]{24}$/i),
  date: z.string(),
  time: z.string(),
  consultationType: z.enum(['OFFLINE', 'ONLINE']).default('OFFLINE'),
});

router.post('/appointments', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const parsed = appointmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid appointment payload.', details: parsed.error.flatten() });
  }

  const slot = clinicDateTimeToDate(parsed.data.date, parsed.data.time);
  if (!slot) {
    return res.status(400).json({ success: false, message: 'Choose a time from 00:00 to 23:50 in 10-minute intervals.' });
  }
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return res.status(400).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }

  const existingPayment = await Payment.findOne({ patientId: req.user?.id, idempotencyKey });
  if (existingPayment) {
    const existingAppointment = await Appointment.findOne({ _id: existingPayment.appointmentId, patientId: req.user?.id });
    if (!existingAppointment) {
      return res.status(409).json({ success: false, message: 'The previous booking request could not be recovered.' });
    }
    return res.json(successResponse('Existing appointment checkout loaded.', {
      appointment: existingAppointment,
      checkout: {
        keyId: env.razorpayKeyId,
        orderId: existingPayment.providerOrderId,
        amount: existingPayment.amountPaise,
        currency: existingPayment.currency,
      },
    }));
  }

  if (parsed.data.date < getClinicDate(new Date()) || slot <= new Date()) {
    return res.status(400).json({ success: false, message: 'Appointment slots must be in the future.' });
  }

  const doctor = await Doctor.findById(parsed.data.doctorId);
  if (!doctor) {
    return res.status(404).json({ success: false, message: 'Doctor not found.' });
  }

  if (await Appointment.exists({ doctorId: doctor.id, slot })) {
    return res.status(409).json({ success: false, message: 'That appointment slot is no longer available.' });
  }

  let appointment;
  try {
    appointment = await Appointment.create({
      patientId: req.user?.id,
      doctorId: doctor.id,
      doctorName: doctor.name,
      department: doctor.department,
      slot,
      fee: doctor.fee,
      status: 'PAYMENT_PENDING',
      consultationType: parsed.data.consultationType,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ success: false, message: 'That appointment slot is no longer available.' });
    }
    throw error;
  }

  try {
    const amountPaise = Math.round(doctor.fee * 100);
    if (amountPaise < 1) {
      throw new Error('Doctor consultation fee must be at least one paise.');
    }
    const order = await getRazorpayClient().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: appointment.id,
      notes: { appointmentId: appointment.id, patientId: req.user?.id || '' },
    });
    const payment = await Payment.create({
      patientId: req.user?.id,
      appointmentId: appointment.id,
      providerOrderId: order.id,
      amountPaise,
      currency: 'INR',
      status: 'CREATED',
      idempotencyKey,
    });
    const appointmentEvent = {
      appointmentId: appointment.id,
      status: appointment.status,
      slot: appointment.slot.toISOString(),
    };
    publishUserEvent(doctor.userId.toString(), 'appointment.created', appointmentEvent);
    publishAdminEvent('appointment.created', appointmentEvent);
    return res.status(201).json(successResponse('Appointment reserved. Complete payment to confirm it.', {
      appointment,
      checkout: { keyId: env.razorpayKeyId, orderId: payment.providerOrderId, amount: amountPaise, currency: 'INR' },
    }));
  } catch (error) {
    await Appointment.deleteOne({ _id: appointment._id, status: 'PAYMENT_PENDING' });
    if (error instanceof PaymentConfigurationError) {
      return res.status(503).json({ success: false, message: 'Razorpay is not configured.' });
    }
    throw error;
  }
});

router.patch('/appointments/:id/cancel', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const capturedPayment = await Payment.exists({ appointmentId: req.params.id, patientId: req.user?.id, status: 'CAPTURED' });
  if (capturedPayment) {
    return res.status(409).json({ success: false, message: 'Paid appointments must be cancelled through the hospital.' });
  }
  const appointment = await Appointment.findOneAndUpdate(
    { _id: req.params.id, patientId: req.user?.id, status: { $in: ['PAYMENT_PENDING', 'REQUESTED'] } },
    { $set: { status: 'CANCELLED' } },
    { new: true },
  );
  if (!appointment) {
    return res.status(404).json({ success: false, message: 'Requested appointment not found.' });
  }

  const doctor = await Doctor.findById(appointment.doctorId).select('userId');
  const appointmentEvent = { appointmentId: appointment.id, status: appointment.status };
  if (doctor) publishUserEvent(doctor.userId.toString(), 'appointment.cancelled', appointmentEvent);
  publishAdminEvent('appointment.cancelled', appointmentEvent);
  return res.json(successResponse('Appointment cancelled.', appointment));
});

const addressSchema = z.object({
  deliveryAddress: z.string().trim().min(8).max(500),
});

router.patch('/profile/address', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const parsed = addressSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a delivery address between 8 and 500 characters.' });
  }

  const user = await User.findOneAndUpdate(
    { _id: req.user?.id, role: 'patient' },
    { $set: { deliveryAddress: parsed.data.deliveryAddress } },
    { new: true },
  ).select('_id deliveryAddress');
  if (!user) {
    return res.status(404).json({ success: false, message: 'Patient account not found.' });
  }
  return res.json(successResponse('Delivery address saved.', { deliveryAddress: user.deliveryAddress }));
});

router.get('/orders', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const orders = await PharmacyOrder.find({ patientId: req.user?.id }).sort({ createdAt: -1 }).lean();
  return res.json(successResponse('Medicine orders loaded.', orders));
});

export default router;
