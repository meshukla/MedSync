import { QueueEvents } from 'bullmq';
import { createBullMQConnection } from '../config/redis';
import {
  closeNotificationQueue,
  notificationQueue,
} from '../queues/notificationQueue';
import {
  NOTIFICATION_HEALTH_CHECK_JOB,
  NOTIFICATION_QUEUE_NAME,
} from '../queues/notificationJobs';

const connection = createBullMQConnection();
const queueEvents = new QueueEvents(NOTIFICATION_QUEUE_NAME, { connection });

const testNotificationQueue = async () => {
  try {
    await queueEvents.waitUntilReady();
    const job = await notificationQueue.add(NOTIFICATION_HEALTH_CHECK_JOB, {
      type: 'health-check',
    });
    const result = await job.waitUntilFinished(queueEvents, 30_000);
    if (result.status !== 'ready') {
      throw new Error('Notification worker returned an unexpected health-check result.');
    }
    console.log('Notification queue test result:', result.status);
  } catch (error) {
    console.error('Notification queue test failed:', error);
    process.exitCode = 1;
  } finally {
    try {
      await queueEvents.close();
    } catch (error) {
      console.error('Unable to close notification queue events:', error);
      process.exitCode = 1;
    }
    try {
      if (connection.status === 'ready') {
        await connection.quit();
      } else {
        connection.disconnect();
      }
    } catch (error) {
      console.error('Unable to close notification queue test connection:', error);
      process.exitCode = 1;
    }
    try {
      await closeNotificationQueue();
    } catch (error) {
      console.error('Unable to close notification queue:', error);
      process.exitCode = 1;
    }
  }
};

void testNotificationQueue();
