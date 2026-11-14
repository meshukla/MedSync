import { Router } from 'express';
import { z } from 'zod';
import { Appointment } from '../models/Appointment';
import { Doctor } from '../models/Clinic';
import { Payment } from '../models/Payment';
import { PharmacyOrder } from '../models/PharmacyOrder';
import { Prescription } from '../models/Prescription';
import { User } from '../models/User';
import { requireAuth, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { publishAdminEvent, publishRoleEvent, publishUserEvent } from '../realtime/socket';
import { signPrescription } from '../utils/prescriptionSignature';
import { successResponse } from '../utils/response';

const router = Router();

router.get('/appointments', requireAuth, requireRole('doctor'), async (req: AuthenticatedRequest, res) => {
  const doctor = await Doctor.findOne({ userId: req.user?.id }).select('_id');
  if (!doctor) {
    return res.status(404).json({ success: false, message: 'Doctor profile not found.' });
  }

  const appointments = await Appointment.find({ doctorId: doctor.id }).populate('patientId', 'name phone').sort({ slot: 1 }).lean();
  return res.json(successResponse('Doctor appointments loaded.', appointments));
});

const statusSchema = z.object({
  status: z.enum(['CONFIRMED', 'CANCELLED']),
});

const prescriptionSchema = z.object({
  items: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    dosage: z.string().trim().min(1).max(120),
    frequency: z.string().trim().min(1).max(120),
    duration: z.string().trim().min(1).max(120),
    quantity: z.number().int().min(1).max(1000),
    instructions: z.string().trim().max(1000).optional(),
  })).min(1).max(30),
  notes: z.string().trim().max(2000).optional(),
});

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

router.post('/appointments/:id/prescription', requireAuth, requireRole('doctor'), async (req: AuthenticatedRequest, res) => {
  const appointmentId = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  const parsed = prescriptionSchema.safeParse(req.body);
  if (!appointmentId.success || !parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a valid appointment and prescription.' });
  }

  const doctor = await Doctor.findOne({ userId: req.user?.id }).select('_id name');
  if (!doctor) {
    return res.status(404).json({ success: false, message: 'Doctor profile not found.' });
  }
  const appointment = await Appointment.findOne({
    _id: appointmentId.data,
    doctorId: doctor._id,
    status: 'CONFIRMED',
  });
  if (!appointment) {
    return res.status(404).json({ success: false, message: 'Confirmed appointment not found.' });
  }
  if (appointment.consultationType === 'ONLINE' && !appointment.videoConsultationCompletedAt) {
    return res.status(409).json({ success: false, message: 'Finish the video consultation before signing its prescription.' });
  }
  if (await Prescription.exists({ appointmentId: appointment._id })) {
    return res.status(409).json({ success: false, message: 'A prescription has already been signed for this appointment.' });
  }
  if (!await Payment.exists({ appointmentId: appointment._id, status: 'CAPTURED' })) {
    return res.status(409).json({ success: false, message: 'The consultation payment must be confirmed before prescribing.' });
  }

  const [patient, doctorUser] = await Promise.all([
    User.findOne({ _id: appointment.patientId, role: 'patient' }).select('_id name phone deliveryAddress'),
    User.findById(req.user?.id).select('_id name'),
  ]);
  if (!patient || !doctorUser) {
    return res.status(404).json({ success: false, message: 'Patient or doctor account not found.' });
  }
  if (!patient.deliveryAddress?.trim()) {
    return res.status(409).json({ success: false, message: 'Ask the patient to save a delivery address before sending a prescription to the pharmacy.' });
  }

  const signedAt = new Date();
  const prescriptionData = {
    appointmentId: appointment._id,
    patientId: patient._id,
    doctorId: doctor._id,
    doctorName: doctor.name,
    items: parsed.data.items,
    notes: parsed.data.notes,
    digitalSignature: {
      algorithm: 'HMAC-SHA256' as const,
      value: '',
      signedBy: doctorUser._id,
      signedByName: doctorUser.name,
      signedAt,
    },
  };
  prescriptionData.digitalSignature.value = signPrescription(prescriptionData);

  let prescription;
  try {
    prescription = await Prescription.create({
      ...prescriptionData,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ success: false, message: 'A prescription has already been signed for this appointment.' });
    }
    throw error;
  }

  let pharmacyOrder;
  let completedAppointment;
  try {
    pharmacyOrder = await PharmacyOrder.create({
      patientId: patient._id,
      appointmentId: appointment._id,
      prescriptionId: prescription._id,
      deliveryAddress: patient.deliveryAddress,
      status: 'PRESCRIPTION_RECEIVED',
      total: 0,
      items: parsed.data.items.map((item) => ({ ...item, price: 0 })),
    });
    completedAppointment = await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: 'CONFIRMED' },
      { $set: { status: 'COMPLETED' } },
      { new: true },
    );
    if (!completedAppointment) {
      await PharmacyOrder.deleteOne({ _id: pharmacyOrder._id });
      await Prescription.deleteOne({ _id: prescription._id });
      return res.status(409).json({ success: false, message: 'Appointment status changed before the prescription could be submitted.' });
    }
  } catch (error) {
    if (pharmacyOrder) await PharmacyOrder.deleteOne({ _id: pharmacyOrder._id });
    await Prescription.deleteOne({ _id: prescription._id });
    throw error;
  }

  const event = {
    appointmentId: appointment.id,
    pharmacyOrderId: pharmacyOrder.id,
    prescriptionId: prescription.id,
    status: 'PRESCRIPTION_RECEIVED',
  };
  publishUserEvent(patient.id, 'prescription.signed', event);
  publishRoleEvent('pharmacist', 'prescription.received', event);
  publishAdminEvent('prescription.received', event);
  publishUserEvent(doctorUser.id, 'appointment.completed', {
    appointmentId: appointment.id,
    status: 'COMPLETED',
  });
  return res.status(201).json(successResponse('Prescription signed and sent to the pharmacy.', {
    prescription,
    pharmacyOrderId: pharmacyOrder.id,
    appointment: completedAppointment,
  }));
});

router.patch('/appointments/:id/status', requireAuth, requireRole('doctor'), async (req: AuthenticatedRequest, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid appointment status.' });
  }

  const doctor = await Doctor.findOne({ userId: req.user?.id }).select('_id');
  if (!doctor) {
    return res.status(404).json({ success: false, message: 'Doctor profile not found.' });
  }
  const allowedFrom: Record<typeof parsed.data.status, string[]> = {
    CONFIRMED: ['REQUESTED'],
    CANCELLED: ['REQUESTED', 'CONFIRMED'],
  };
  const appointmentToCancel = parsed.data.status === 'CANCELLED'
    ? await Appointment.findOne({ _id: req.params.id, doctorId: doctor.id }).select('_id')
    : null;
  if (parsed.data.status === 'CANCELLED' && !appointmentToCancel) {
    return res.status(404).json({ success: false, message: 'Appointment not found.' });
  }
  const capturedPayment = parsed.data.status === 'CANCELLED'
    ? await Payment.exists({ appointmentId: appointmentToCancel?._id, status: 'CAPTURED' })
    : false;
  if (capturedPayment) {
    return res.status(409).json({ success: false, message: 'Paid appointments must be cancelled through the hospital.' });
  }

  const appointment = await Appointment.findOneAndUpdate(
    { _id: req.params.id, doctorId: doctor.id, status: { $in: allowedFrom[parsed.data.status] } },
    { $set: { status: parsed.data.status } },
    { new: true },
  );
  if (!appointment) {
    return res.status(404).json({ success: false, message: 'Appointment not found or the status has changed.' });
  }

  const eventName = `appointment.${appointment.status.toLowerCase()}`;
  publishUserEvent(appointment.patientId.toString(), eventName, {
    appointmentId: appointment.id,
    status: appointment.status,
  });
  publishAdminEvent(eventName, { appointmentId: appointment.id, status: appointment.status });
  return res.json(successResponse('Appointment updated.', appointment));
});

export default router;
