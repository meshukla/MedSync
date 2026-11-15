import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import { Appointment } from '../models/Appointment';
import { User } from '../models/User';
import { PharmacyOrder } from '../models/PharmacyOrder';
import { closeRedisConnection, createBullMQConnection } from '../config/redis';
import { env } from '../config/env';
import {
  APPOINTMENT_CONFIRMATION_JOB,
  NOTIFICATION_HEALTH_CHECK_JOB,
  NOTIFICATION_QUEUE_NAME,
  PHARMACY_PRESCRIPTION_JOB,
  NotificationJobData,
  NotificationJobResult,
} from '../queues/notificationJobs';
import {
  sendAppointmentConfirmationEmail,
  sendPharmacyPrescriptionNotificationEmail,
} from '../services/email';

export type NotificationWorkerHandle = {
  close: () => Promise<void>;
};

export const startNotificationWorker = async (): Promise<NotificationWorkerHandle> => {
  const connection = createBullMQConnection();
  connection.on('error', (error) => {
    console.error('Notification worker Redis error:', error.message);
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
    });

    worker.on('error', (error) => {
      console.error('Notification worker error:', error.message);
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
