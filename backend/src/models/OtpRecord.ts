import { model, models, Schema, Types } from 'mongoose';

export type OtpRecordDocument = {
  _id: Types.ObjectId;
  email: string;
  purpose: 'EMAIL_VERIFICATION';
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  sentAt: Date;
  windowStartedAt: Date;
  sendCount: number;
  consumedAt?: Date;
};

const otpRecordSchema = new Schema<OtpRecordDocument>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: { type: String, enum: ['EMAIL_VERIFICATION'], required: true },
    codeHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, required: true, default: 0 },
    sentAt: { type: Date, required: true },
    windowStartedAt: { type: Date, required: true },
    sendCount: { type: Number, required: true, default: 1 },
    consumedAt: { type: Date },
  },
  { timestamps: true },
);

otpRecordSchema.index({ email: 1, purpose: 1 }, { unique: true });
otpRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpRecord = models.OtpRecord || model<OtpRecordDocument>('OtpRecord', otpRecordSchema);
