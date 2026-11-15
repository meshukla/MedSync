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
import { publishAdminEvent, publishRoleEvent, publishUserEvent } from '../realtime/socket';
import { successResponse } from '../utils/response';
import { recordAudit } from '../utils/audit';
import { requestFullRefund } from '../services/refunds';
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
  const doctor = await Doctor.findById(doctorId.data).select('weeklyAvailability');
  if (!doctor) {
    return res.status(404).json({ success: false, message: 'Doctor not found.' });
  }

  const slots = getClinicSlots(date.data, new Date(), doctor.weeklyAvailability || []);
  const appointments = slots.length
    ? await Appointment.find({
      doctorId: doctorId.data,
      status: { $in: ['REQUESTED', 'PAYMENT_PENDING', 'CONFIRMED'] },
      slot: { $in: slots.map(({ slot }) => slot) },
    })
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
      refundStatus: payment?.refundStatus,
      refundAmountPaise: payment?.refundAmountPaise,
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
    if (!existingPayment.appointmentId) {
      return res.status(409).json({ success: false, message: 'The previous booking request could not be recovered.' });
    }
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

  if (await Appointment.exists({
    doctorId: doctor.id,
    slot,
    status: { $in: ['REQUESTED', 'PAYMENT_PENDING', 'CONFIRMED'] },
  })) {
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

const rescheduleSchema = z.object({
  date: z.string(),
  time: z.string(),
});

router.patch('/appointments/:id/reschedule', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const appointmentId = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!appointmentId.success || !parsed.success || !isValidClinicDate(parsed.data.date)) {
    return res.status(400).json({ success: false, message: 'Choose a valid appointment date and time.' });
  }

  const appointment = await Appointment.findOne({
    _id: appointmentId.data,
    patientId: req.user?.id,
    status: { $in: ['REQUESTED', 'PAYMENT_PENDING', 'CONFIRMED'] },
  });
  if (!appointment) {
    return res.status(404).json({ success: false, message: 'Active appointment not found.' });
  }
  const nextSlot = clinicDateTimeToDate(parsed.data.date, parsed.data.time);
  if (!nextSlot || nextSlot <= new Date() || nextSlot.getTime() === appointment.slot.getTime()) {
    return res.status(400).json({ success: false, message: 'Choose a different future appointment time.' });
  }

  const doctor = await Doctor.findById(appointment.doctorId).select('userId weeklyAvailability');
  if (!doctor) {
    return res.status(404).json({ success: false, message: 'Doctor not found.' });
  }
  const availableSlots = getClinicSlots(parsed.data.date, new Date(), doctor.weeklyAvailability || []);
  if (!availableSlots.some(({ slot }) => slot.getTime() === nextSlot.getTime())) {
    return res.status(400).json({ success: false, message: "That time is outside the doctor's available schedule." });
  }

  let updatedAppointment;
  try {
    updatedAppointment = await Appointment.findOneAndUpdate(
      { _id: appointment._id, patientId: req.user?.id, status: appointment.status, slot: appointment.slot },
      { $set: { slot: nextSlot, rescheduledAt: new Date() }, $inc: { rescheduleCount: 1 } },
      { new: true },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ success: false, message: 'That appointment slot is no longer available.' });
    }
    throw error;
  }
  if (!updatedAppointment) {
    return res.status(409).json({ success: false, message: 'The appointment changed. Refresh and try again.' });
  }

  const event = {
    appointmentId: updatedAppointment.id,
    status: updatedAppointment.status,
    previousSlot: appointment.slot.toISOString(),
    slot: updatedAppointment.slot.toISOString(),
  };
  await recordAudit(req, {
    action: 'appointment.rescheduled',
    entityType: 'appointment',
    entityId: updatedAppointment.id,
    details: event,
  });
  publishUserEvent(req.user?.id || '', 'appointment.rescheduled', event);
  publishUserEvent(doctor.userId.toString(), 'appointment.rescheduled', event);
  publishAdminEvent('appointment.rescheduled', event);
  return res.json(successResponse('Appointment rescheduled.', updatedAppointment));
});

router.patch('/appointments/:id/cancel', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const appointment = await Appointment.findOne({
    _id: req.params.id,
    patientId: req.user?.id,
    status: { $in: ['PAYMENT_PENDING', 'REQUESTED', 'CONFIRMED'] },
  });
  if (!appointment) {
    return res.status(404).json({ success: false, message: 'Active appointment not found.' });
  }

  const payment = await Payment.findOne({
    appointmentId: appointment._id,
    patientId: req.user?.id,
    status: 'CAPTURED',
  });
  if (payment) {
    if (appointment.slot.getTime() - Date.now() < 24 * 60 * 60_000) {
      return res.status(409).json({
        success: false,
        message: 'Paid appointments can be cancelled for a full refund at least 24 hours in advance. Contact the hospital for an exception.',
      });
    }
    const refundResult = await requestFullRefund(payment, 'patient_cancellation_at_least_24_hours_before');
    if (!refundResult.success) {
      return res.status(409).json({ success: false, message: refundResult.message });
    }
    await recordAudit(req, {
      action: 'appointment.refund_requested',
      entityType: 'payment',
      entityId: payment.id,
      details: { appointmentId: appointment.id, amountPaise: payment.amountPaise, refundId: refundResult.payment.refundId },
    });
  }

  const cancelledAppointment = await Appointment.findOneAndUpdate(
    { _id: appointment._id, patientId: req.user?.id, status: appointment.status },
    { $set: { status: 'CANCELLED' } },
    { new: true },
  );
  if (!cancelledAppointment) {
    return res.status(409).json({ success: false, message: 'The appointment changed. Refresh and try again.' });
  }
  const doctor = await Doctor.findById(appointment.doctorId).select('userId');
  const appointmentEvent = {
    appointmentId: appointment.id,
    status: cancelledAppointment.status,
    refundStatus: payment?.refundStatus === 'NOT_REQUESTED' ? 'PENDING' : payment?.refundStatus,
  };
  await recordAudit(req, {
    action: 'appointment.cancelled',
    entityType: 'appointment',
    entityId: appointment.id,
    details: { refundStatus: payment ? 'PENDING' : 'NOT_APPLICABLE' },
  });
  if (payment) publishUserEvent(req.user?.id || '', 'appointment.refund-status', appointmentEvent);
  publishUserEvent(req.user?.id || '', 'appointment.cancelled', appointmentEvent);
  if (doctor) publishUserEvent(doctor.userId.toString(), 'appointment.cancelled', appointmentEvent);
  publishAdminEvent('appointment.cancelled', appointmentEvent);
  return res.json(successResponse('Appointment cancelled.', cancelledAppointment));
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
  const event = { patientId: user.id };
  publishUserEvent(user.id, 'patient.address-updated', event);
  publishRoleEvent('pharmacist', 'patient.address-updated', event);
  publishAdminEvent('patient.address-updated', event);
  return res.json(successResponse('Delivery address saved.', { deliveryAddress: user.deliveryAddress }));
});

router.get('/orders', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const orders = await PharmacyOrder.find({ patientId: req.user?.id }).sort({ createdAt: -1 }).lean();
  return res.json(successResponse('Medicine orders loaded.', orders));
});

export default router;
