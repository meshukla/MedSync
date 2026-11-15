export const NOTIFICATION_QUEUE_NAME = 'medsync-notifications';
export const NOTIFICATION_HEALTH_CHECK_JOB = 'health-check';
export const APPOINTMENT_CONFIRMATION_JOB = 'appointment-confirmation';
export const PHARMACY_PRESCRIPTION_JOB = 'pharmacy-prescription';
export const EMAIL_NOTIFICATION_JOB = 'email-notification';
export const APPOINTMENT_REMINDER_JOB = 'appointment-reminder';

export type NotificationJobData =
  | { type: 'health-check' }
  | { type: 'appointment-confirmation'; appointmentId: string }
  | { type: 'pharmacy-prescription'; orderId: string; pharmacistId: string }
  | { type: 'email-notification'; notificationId: string }
  | { type: 'appointment-reminder'; appointmentId: string; slot: string };

export type NotificationJobResult =
  | { status: 'ready' }
  | { status: 'sent' }
  | {
    status: 'skipped'
    reason: 'appointment-not-confirmed' | 'pharmacy-order-not-open' | 'pharmacist-unavailable' | 'appointment-changed' | 'notification-unavailable'
  };
