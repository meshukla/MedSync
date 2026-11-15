import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import { Appointment } from '../models/Appointment';
import { User } from '../models/User';
import { PharmacyOrder } from '../models/PharmacyOrder';
import { Notification } from '../models/Notification';
import { closeRedisConnection, createBullMQConnection } from '../config/redis';
import { env } from '../config/env';
import {
  APPOINTMENT_CONFIRMATION_JOB,
  APPOINTMENT_REMINDER_JOB,
  EMAIL_NOTIFICATION_JOB,
  NOTIFICATION_HEALTH_CHECK_JOB,
  NOTIFICATION_QUEUE_NAME,
  PHARMACY_PRESCRIPTION_JOB,
  NotificationJobData,
  NotificationJobResult,
} from '../queues/notificationJobs';
import {
  sendAppointmentConfirmationEmail,
  sendPharmacyPrescriptionNotificationEmail,
  sendNotificationEmail,
} from '../services/email';
import { sendAppointmentReminder } from '../services/notifications';
import { notifyCriticalIssue, notifyRole } from '../services/userNotifications';

export type NotificationWorkerHandle = {
  close: () => Promise<void>;
};

export const startNotificationWorker = async (): Promise<NotificationWorkerHandle> => {
  const connection = createBullMQConnection();
  let infrastructureErrorAlerted = false;
  const alertInfrastructureError = () => {
    if (infrastructureErrorAlerted) return;
    infrastructureErrorAlerted = true;
    void notifyCriticalIssue('process').catch((notificationError: unknown) => {
      console.error('Unable to alert administrators about a notification worker error:', notificationError);
    });
  };
  connection.on('error', (error) => {
    console.error('Notification worker Redis error:', error.message);
    alertInfrastructureError();
  });

  let worker: Worker<NotificationJobData, NotificationJobResult> | undefined;
  try {
    worker = new Worker<NotificationJobData, NotificationJobResult>(
      NOTIFICATION_QUEUE_NAME,
      async (job) => {
        if (job.name === NOTIFICATION_HEALTH_CHECK_JOB && job.data.type === 'health-check') {
          return { status: 'ready' };
        }

        if (
          job.name === EMAIL_NOTIFICATION_JOB
          && job.data.type === 'email-notification'
          && /^[a-f\d]{24}$/i.test(job.data.notificationId)
        ) {
          const notification = await Notification.findOne({
            _id: job.data.notificationId,
            emailSentAt: { $exists: false },
          }).select('recipientId emailSubject emailText');
          if (!notification?.emailSubject || !notification.emailText) {
            return { status: 'skipped', reason: 'notification-unavailable' };
          }
          const recipient = await User.findById(notification.recipientId).select('email');
          if (!recipient) throw new Error('Notification recipient was not found.');
          await sendNotificationEmail(recipient.email, notification.emailSubject, notification.emailText);
          await Notification.updateOne(
            { _id: notification._id, emailSentAt: { $exists: false } },
            { $set: { emailSentAt: new Date() } },
          );
          return { status: 'sent' };
        }

        if (
          job.name === APPOINTMENT_REMINDER_JOB
          && job.data.type === 'appointment-reminder'
          && /^[a-f\d]{24}$/i.test(job.data.appointmentId)
          && !Number.isNaN(Date.parse(job.data.slot))
        ) {
          const sent = await sendAppointmentReminder(job.data.appointmentId, job.data.slot);
          return sent ? { status: 'sent' } : { status: 'skipped', reason: 'appointment-changed' };
        }

        if (
          job.name === APPOINTMENT_CONFIRMATION_JOB
          && job.data.type === 'appointment-confirmation'
          && /^[a-f\d]{24}$/i.test(job.data.appointmentId)
        ) {
          const appointment = await Appointment.findById(job.data.appointmentId)
            .select('patientId slot status');
          if (!appointment || appointment.status !== 'CONFIRMED') {
            return { status: 'skipped', reason: 'appointment-not-confirmed' };
          }

          const patient = await User.findById(appointment.patientId).select('email');
          if (!patient) {
            throw new Error('Patient record for appointment confirmation was not found.');
          }

          await sendAppointmentConfirmationEmail(patient.email, appointment.slot);
          return { status: 'sent' };
        }

        if (
          job.name === PHARMACY_PRESCRIPTION_JOB
          && job.data.type === 'pharmacy-prescription'
          && /^[a-f\d]{24}$/i.test(job.data.orderId)
          && /^[a-f\d]{24}$/i.test(job.data.pharmacistId)
        ) {
          const [order, pharmacist] = await Promise.all([
            PharmacyOrder.findById(job.data.orderId).select('_id prescriptionId status'),
            User.findOne({
              _id: job.data.pharmacistId,
              role: 'pharmacist',
              isActive: true,
            }).select('email'),
          ]);
          if (!order?.prescriptionId || order.status !== 'PRESCRIPTION_RECEIVED') {
            return { status: 'skipped', reason: 'pharmacy-order-not-open' };
          }
          if (!pharmacist) {
            return { status: 'skipped', reason: 'pharmacist-unavailable' };
          }

          await sendPharmacyPrescriptionNotificationEmail(pharmacist.email);
          return { status: 'sent' };
        }

        throw new Error('Unsupported or invalid notification job.');
      },
      {
        connection,
        concurrency: 5,
      },
    );

    worker.on('completed', (job) => {
      console.log(`Notification worker completed job ${job.id}`);
    });

    worker.on('failed', (job, error) => {
      console.error(`Notification job ${job?.id ?? 'unknown'} failed:`, error.message);
      if (
        (job?.data.type === 'email-notification' || job?.data.type === 'appointment-reminder')
        && job.attemptsMade >= (job.opts.attempts ?? 1)
      ) {
        void job.remove().catch((removeError: unknown) => {
          console.error(`Unable to release failed notification job ${job.id}:`, removeError);
        });
      }
      if (
        job?.name === APPOINTMENT_CONFIRMATION_JOB
        && job.data.type === 'appointment-confirmation'
        && /^[a-f\d]{24}$/i.test(job.data.appointmentId)
        && job.attemptsMade >= (job.opts.attempts ?? 1)
      ) {
        const appointmentId = job.data.appointmentId;
        const jobId = job.id;
        void (async () => {
          try {
            await job.remove();
            await Appointment.updateOne(
              { _id: appointmentId },
              { $unset: { confirmationNotificationQueuedAt: '' } },
            );
          } catch (recoveryError) {
            console.error(`Unable to release failed appointment notification ${jobId}:`, recoveryError);
          }
        })();
      }
      const emailJob = job?.data.type === 'email-notification';
      void notifyRole('admin', {
        event: 'system.notification-error',
        title: 'Notification delivery issue',
        message: 'A notification task failed. Review the backend logs for details.',
        dedupeKey: `notification-job-failed:${job?.id ?? 'unknown'}`,
        ...(!emailJob ? {
          email: {
            subject: 'MedSync notification system error',
            text: 'A notification task failed. Review the backend logs for details.',
          },
        } : {}),
      }).catch((notificationError: unknown) => {
        console.error('Unable to alert administrators about a notification error:', notificationError);
      });
    });

    worker.on('error', (error) => {
      console.error('Notification worker error:', error.message);
      alertInfrastructureError();
    });

    await worker.waitUntilReady();
    console.log('MedSync notification worker started');

    let closePromise: Promise<void> | undefined;
    return {
      close: () => {
        if (!closePromise) {
          closePromise = (async () => {
            let workerCloseError: unknown;
            try {
              await worker?.close();
            } catch (error) {
              workerCloseError = error;
            }

            try {
              await closeRedisConnection(connection);
            } catch (error) {
              console.error('Unable to close notification worker Redis connection:', error);
              throw error;
            }

            if (workerCloseError) throw workerCloseError;
          })();
        }
        return closePromise;
      },
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      ...(worker ? [worker.close()] : []),
      closeRedisConnection(connection),
    ]);
    cleanup.forEach((result) => {
      if (result.status === 'rejected') {
        console.error('Unable to clean up after notification worker startup failure:', result.reason);
      }
    });
    throw error;
  }
};

if (require.main === module) {
  let workerHandle: NotificationWorkerHandle | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string) => {
    if (!shutdownPromise) {
      console.log(`Notification worker received ${signal}; shutting down.`);
      shutdownPromise = (async () => {
        try {
          await workerHandle?.close();
        } catch (error) {
          console.error('Unable to shut down notification worker:', error);
          process.exitCode = 1;
        }
        try {
          await mongoose.disconnect();
        } catch (error) {
          console.error('Unable to disconnect notification worker from MongoDB:', error);
          process.exitCode = 1;
        }
      })();
    }
    return shutdownPromise;
  };

  void (async () => {
    try {
      await mongoose.connect(env.mongoUri);
      workerHandle = await startNotificationWorker();
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
    } catch (error: unknown) {
      console.error('MedSync notification worker failed to start:', error);
      await shutdown('startup failure');
      process.exitCode = 1;
    }
  })();
}
