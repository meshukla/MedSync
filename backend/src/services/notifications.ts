import { Appointment } from '../models/Appointment';
import { notificationQueue } from '../queues/notificationQueue';
import { User } from '../models/User';
import { Doctor } from '../models/Clinic';
import { PharmacyOrder } from '../models/PharmacyOrder';
import {
  APPOINTMENT_CONFIRMATION_JOB,
  APPOINTMENT_REMINDER_JOB,
  PHARMACY_PRESCRIPTION_JOB,
} from '../queues/notificationJobs';
import { notifyUsers } from './userNotifications';

export const queueAppointmentConfirmation = async (appointmentId: string) => {
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    status: 'CONFIRMED',
  }).select('_id confirmationNotificationQueuedAt');
  if (!appointment || appointment.confirmationNotificationQueuedAt) return false;

  await notificationQueue.add(
    APPOINTMENT_CONFIRMATION_JOB,
    { type: 'appointment-confirmation', appointmentId },
    { jobId: `appointment-confirmation-${appointmentId}` },
  );
  const marked = await Appointment.updateOne(
    { _id: appointment._id, confirmationNotificationQueuedAt: { $exists: false } },
    { $set: { confirmationNotificationQueuedAt: new Date() } },
  );
  if (marked.matchedCount === 0 && !await Appointment.exists({
    _id: appointment._id,
    confirmationNotificationQueuedAt: { $exists: true },
  })) {
    throw new Error('Unable to record the queued appointment confirmation notification.');
  }
  return true;
};

export const queueAppointmentReminder = async (appointmentId: string) => {
  const appointment = await Appointment.findOne({ _id: appointmentId, status: 'CONFIRMED' })
    .select('_id slot');
  if (!appointment) return false;
  await notificationQueue.add(
    APPOINTMENT_REMINDER_JOB,
    { type: 'appointment-reminder', appointmentId, slot: appointment.slot.toISOString() },
    {
      jobId: `appointment-reminder-${appointmentId}-${appointment.slot.getTime()}`,
      delay: Math.max(0, appointment.slot.getTime() - 5 * 60_000 - Date.now()),
    },
  );
  return true;
};

export const sendAppointmentReminder = async (appointmentId: string, slot: string) => {
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    status: 'CONFIRMED',
    slot: new Date(slot),
  }).select('_id patientId doctorId slot doctorName');
  if (!appointment) return false;
  const doctor = await Doctor.findById(appointment.doctorId).select('userId');
  if (!doctor) throw new Error('Doctor record for appointment reminder was not found.');

  const when = appointment.slot.toISOString();
  const patientMessage = `Your appointment with ${appointment.doctorName} starts in about 5 minutes.`;
  const metadata = { appointmentId: appointment.id, slot: when };
  await notifyUsers([appointment.patientId.toString()], {
    event: 'appointment.reminder',
    title: 'Appointment reminder',
    message: patientMessage,
    metadata,
    dedupeKey: `appointment-reminder-patient:${appointment.id}:${appointment.slot.getTime()}`,
    email: { subject: 'Your MedSync appointment starts soon', text: patientMessage },
  });
  const doctorMessage = 'You have a patient appointment starting in about 5 minutes.';
  await notifyUsers([doctor.userId.toString()], {
    event: 'appointment.reminder',
    title: 'Upcoming appointment reminder',
    message: doctorMessage,
    metadata,
    dedupeKey: `appointment-reminder-doctor:${appointment.id}:${appointment.slot.getTime()}`,
    email: { subject: 'Upcoming MedSync appointment', text: doctorMessage },
  });
  return true;
};

export const queuePharmacyPrescriptionNotifications = async (orderId: string) => {
  const order = await PharmacyOrder.findOne({
    _id: orderId,
    status: 'PRESCRIPTION_RECEIVED',
  }).select('_id pharmacyNotificationQueuedAt');
  if (!order || order.pharmacyNotificationQueuedAt) return false;

  const pharmacists = await User.find({ role: 'pharmacist', isActive: true }).select('_id');
  if (pharmacists.length === 0) {
    throw new Error('Cannot notify the pharmacy because no active pharmacist accounts exist.');
  }

  await Promise.all(pharmacists.map((pharmacist) => {
    const pharmacistId = pharmacist.id;
    return notificationQueue.add(
      PHARMACY_PRESCRIPTION_JOB,
      { type: 'pharmacy-prescription', orderId, pharmacistId },
      { jobId: `pharmacy-prescription-${orderId}-${pharmacistId}` },
    );
  }));
  const marked = await PharmacyOrder.updateOne(
    { _id: order._id, pharmacyNotificationQueuedAt: { $exists: false } },
    { $set: { pharmacyNotificationQueuedAt: new Date() } },
  );
  if (marked.matchedCount === 0 && !await PharmacyOrder.exists({
    _id: order._id,
    pharmacyNotificationQueuedAt: { $exists: true },
  })) {
    throw new Error('Unable to record queued pharmacy prescription notifications.');
  }
  return true;
};
