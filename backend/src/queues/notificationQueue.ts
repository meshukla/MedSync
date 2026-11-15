import { Queue } from 'bullmq';
import { closeRedisConnection, createBullMQConnection } from '../config/redis';
import {
  NOTIFICATION_QUEUE_NAME,
  NotificationJobData,
  NotificationJobResult,
} from './notificationJobs';

const connection = createBullMQConnection();

connection.on('error', (error) => {
  console.error('Notification queue Redis error:', error.message);
});

export const notificationQueue = new Queue<
  NotificationJobData,
  NotificationJobResult
>(NOTIFICATION_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export const closeNotificationQueue = async () => {
  try {
    await notificationQueue.close();
  } finally {
    await closeRedisConnection(connection);
  }
};
