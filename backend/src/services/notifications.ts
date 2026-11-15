import { Appointment } from '../models/Appointment';
import { notificationQueue } from '../queues/notificationQueue';
import { User } from '../models/User';
import { PharmacyOrder } from '../models/PharmacyOrder';
import {
  APPOINTMENT_CONFIRMATION_JOB,
  PHARMACY_PRESCRIPTION_JOB,
} from '../queues/notificationJobs';

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
