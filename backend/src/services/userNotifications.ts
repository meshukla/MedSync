import { Notification } from '../models/Notification';
import { User, UserRole } from '../models/User';
import { EMAIL_NOTIFICATION_JOB } from '../queues/notificationJobs';
import { notificationQueue } from '../queues/notificationQueue';
import { publishUserEventIfAvailable } from '../realtime/socket';

export type UserNotificationInput = {
  event: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
  email?: { subject: string; text: string };
};

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

export const notifyUsers = async (userIds: string[], input: UserNotificationInput) => {
  for (const userId of [...new Set(userIds)]) {
    let notification;
    try {
      notification = await Notification.create({
        recipientId: userId,
        event: input.event,
        title: input.title,
        message: input.message,
        metadata: input.metadata || {},
        dedupeKey: input.dedupeKey,
        emailSubject: input.email?.subject,
        emailText: input.email?.text,
      });
    } catch (error) {
      if (input.dedupeKey && isDuplicateKeyError(error)) {
        const existing = await Notification.findOne({
          recipientId: userId,
          dedupeKey: input.dedupeKey,
          emailSentAt: { $exists: false },
        }).select('_id emailSubject emailText');
        if (input.email && existing?.emailSubject && existing.emailText) {
          await notificationQueue.add(
            EMAIL_NOTIFICATION_JOB,
            { type: 'email-notification', notificationId: existing.id },
            { jobId: `email-notification-${existing.id}` },
          );
        }
        continue;
      }
      throw error;
    }

    publishUserEventIfAvailable(userId, 'notification.created', {
      notificationId: notification.id,
      event: input.event,
    });

    if (input.email) {
      await notificationQueue.add(
        EMAIL_NOTIFICATION_JOB,
        { type: 'email-notification', notificationId: notification.id },
        { jobId: `email-notification-${notification.id}` },
      );
    }
  }
};

export const notifyRole = async (role: UserRole, input: UserNotificationInput) => {
  const users = await User.find({ role, isActive: true }).select('_id').lean();
  await notifyUsers(users.map((user) => user._id.toString()), input);
};

export const notifyCriticalIssue = (source: 'api' | 'process') =>
  notifyRole('admin', {
    event: 'system.critical-error',
    title: 'Critical system issue',
    message: 'A critical backend issue occurred. Review the backend logs for details.',
    metadata: { source },
    email: {
      subject: 'MedSync critical system issue',
      text: 'A critical backend issue occurred. Review the backend logs for details.',
    },
  });
