import { model, models, Schema, Types } from 'mongoose';

export type NotificationDocument = {
  _id: Types.ObjectId;
  recipientId: Types.ObjectId;
  event: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  dedupeKey?: string;
  readAt?: Date;
  emailSubject?: string;
  emailText?: string;
  emailSentAt?: Date;
  createdAt: Date;
};

const notificationSchema = new Schema<NotificationDocument>(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    event: { type: String, required: true, maxlength: 100 },
    title: { type: String, required: true, maxlength: 160 },
    message: { type: String, required: true, maxlength: 1000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, maxlength: 200 },
    readAt: { type: Date },
    emailSubject: { type: String, maxlength: 200 },
    emailText: { type: String, maxlength: 5000 },
    emailSentAt: { type: Date },
  },
  { timestamps: true },
);

notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index(
  { recipientId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

export const Notification = models.Notification || model<NotificationDocument>('Notification', notificationSchema);
