import { model, models, Schema, Types } from 'mongoose';

export type PrescriptionItem = {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  quantity: number;
  instructions?: string;
};

export type PrescriptionDocument = {
  _id: Types.ObjectId;
  appointmentId: Types.ObjectId;
  patientId: Types.ObjectId;
  doctorId: Types.ObjectId;
  doctorName: string;
  items: PrescriptionItem[];
  notes?: string;
  digitalSignature: {
    algorithm: 'HMAC-SHA256';
    value: string;
    signedBy: Types.ObjectId;
    signedByName: string;
    signedAt: Date;
  };
  createdAt: Date;
};

const prescriptionSchema = new Schema<PrescriptionDocument>(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true, unique: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    doctorName: { type: String, required: true },
    items: [{
      name: { type: String, required: true, trim: true },
      dosage: { type: String, required: true, trim: true },
      frequency: { type: String, required: true, trim: true },
      duration: { type: String, required: true, trim: true },
      quantity: { type: Number, required: true, min: 1 },
      instructions: { type: String, trim: true, maxlength: 1000 },
    }],
    notes: { type: String, trim: true, maxlength: 2000 },
    digitalSignature: {
      algorithm: { type: String, enum: ['HMAC-SHA256'], required: true },
      value: { type: String, required: true },
      signedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      signedByName: { type: String, required: true },
      signedAt: { type: Date, required: true },
    },
  },
  { timestamps: true },
);

export const Prescription = models.Prescription || model<PrescriptionDocument>('Prescription', prescriptionSchema);
