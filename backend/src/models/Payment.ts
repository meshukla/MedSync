import { model, models, Schema, Types } from 'mongoose';

export const paymentStatuses = ['CREATED', 'CAPTURED', 'FAILED'] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export type PaymentDocument = {
  _id: Types.ObjectId;
  patientId: Types.ObjectId;
  appointmentId?: Types.ObjectId;
  pharmacyOrderId?: Types.ObjectId;
  providerOrderId: string;
  providerPaymentId?: string;
  amountPaise: number;
  currency: 'INR';
  status: PaymentStatus;
  idempotencyKey: string;
  capturedAt?: Date;
};

const paymentSchema = new Schema<PaymentDocument>(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', index: true },
    pharmacyOrderId: { type: Schema.Types.ObjectId, ref: 'PharmacyOrder', unique: true, sparse: true },
    providerOrderId: { type: String, required: true, unique: true },
    providerPaymentId: { type: String, unique: true, sparse: true },
    amountPaise: { type: Number, required: true, min: 1 },
    currency: { type: String, enum: ['INR'], required: true },
    status: { type: String, enum: paymentStatuses, required: true, default: 'CREATED' },
    idempotencyKey: { type: String, required: true },
    capturedAt: { type: Date },
  },
  { timestamps: true },
);

paymentSchema.index({ patientId: 1, idempotencyKey: 1 }, { unique: true });

export const Payment = models.Payment || model<PaymentDocument>('Payment', paymentSchema);
