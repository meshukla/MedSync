import { model, models, Schema, Types } from 'mongoose';

export const pharmacyOrderStatuses = [
  'PRESCRIPTION_RECEIVED',
  'BILL_GENERATED',
  'PAYMENT_PENDING',
  'PAID',
  'PREPARING',
  'READY_FOR_PICKUP',
  'READY_FOR_DISPATCH',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'COLLECTED',
] as const;
export type PharmacyOrderStatus = (typeof pharmacyOrderStatuses)[number];

export type PharmacyOrderDocument = {
  _id: Types.ObjectId;
  patientId: Types.ObjectId;
  appointmentId?: Types.ObjectId;
  prescriptionId?: Types.ObjectId;
  deliveryAddress?: string;
  status: PharmacyOrderStatus;
  total: number;
  items: {
    name: string;
    quantity: number;
    price: number;
    dosage?: string;
    frequency?: string;
    duration?: string;
    instructions?: string;
  }[];
  assignedDeliveryId?: Types.ObjectId;
  stockDeductedAt?: Date;
  deliveredAt?: Date;
  collectedAt?: Date;
  createdAt: Date;
};

const pharmacyOrderSchema = new Schema<PharmacyOrderDocument>(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    prescriptionId: { type: Schema.Types.ObjectId, ref: 'Prescription' },
    deliveryAddress: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: pharmacyOrderStatuses, default: 'PRESCRIPTION_RECEIVED' },
    total: { type: Number, required: true, min: 0 },
    items: [{
      name: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      price: { type: Number, required: true, min: 0 },
      dosage: { type: String, trim: true },
      frequency: { type: String, trim: true },
      duration: { type: String, trim: true },
      instructions: { type: String, trim: true, maxlength: 1000 },
    }],
    assignedDeliveryId: { type: Schema.Types.ObjectId, ref: 'User' },
    stockDeductedAt: { type: Date },
    deliveredAt: { type: Date },
    collectedAt: { type: Date },
  },
  { timestamps: true },
);

export const PharmacyOrder = models.PharmacyOrder || model<PharmacyOrderDocument>('PharmacyOrder', pharmacyOrderSchema);
