import { model, models, Schema, Types } from 'mongoose';

export const appointmentStatuses = ['REQUESTED', 'PAYMENT_PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;
export type AppointmentStatus = (typeof appointmentStatuses)[number];

export type AppointmentDocument = {
  _id: Types.ObjectId;
  patientId: Types.ObjectId;
  doctorId: Types.ObjectId;
  doctorName: string;
  department: string;
  slot: Date;
  fee: number;
  status: AppointmentStatus;
  consultationType: 'OFFLINE' | 'ONLINE';
  confirmationNotificationQueuedAt?: Date;
  videoConsultationCompletedAt?: Date;
  rescheduledAt?: Date;
  rescheduleCount: number;
  createdAt: Date;
};

const appointmentSchema = new Schema<AppointmentDocument>(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    doctorName: { type: String, required: true },
    department: { type: String, required: true },
    slot: { type: Date, required: true },
    fee: { type: Number, required: true, min: 0 },
    status: { type: String, enum: appointmentStatuses, default: 'PAYMENT_PENDING' },
    consultationType: { type: String, enum: ['OFFLINE', 'ONLINE'], default: 'OFFLINE' },
    confirmationNotificationQueuedAt: { type: Date },
    videoConsultationCompletedAt: { type: Date },
    rescheduledAt: { type: Date },
    rescheduleCount: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

appointmentSchema.index(
  { doctorId: 1, slot: 1 },
  {
    name: 'active_doctor_slot',
    unique: true,
    partialFilterExpression: { status: { $in: ['REQUESTED', 'PAYMENT_PENDING', 'CONFIRMED'] } },
  },
);

export const Appointment = models.Appointment || model<AppointmentDocument>('Appointment', appointmentSchema);
