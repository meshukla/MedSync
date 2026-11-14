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
  videoConsultationCompletedAt?: Date;
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
    videoConsultationCompletedAt: { type: Date },
  },
  { timestamps: true },
);

appointmentSchema.index({ doctorId: 1, slot: 1 }, { unique: true });

export const Appointment = models.Appointment || model<AppointmentDocument>('Appointment', appointmentSchema);
