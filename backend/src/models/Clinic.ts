import { model, models, Schema, Types } from 'mongoose';

export type DepartmentDocument = {
  _id: Types.ObjectId;
  name: string;
  code: string;
  description: string;
};

export type DoctorDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  specialization: string;
  department: string;
  fee: number;
  availability: Date[];
  weeklyAvailability?: {
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }[];
};

export type InventoryDocument = {
  _id: Types.ObjectId;
  medicine: string;
  stock: number;
  lowStockThreshold: number;
  deductedOrderIds: Types.ObjectId[];
};

const departmentSchema = new Schema<DepartmentDocument>({
  name: { type: String, required: true, unique: true },
  code: { type: String, required: true, unique: true },
  description: { type: String, required: true },
});

const doctorSchema = new Schema<DoctorDocument>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  name: { type: String, required: true },
  specialization: { type: String, required: true },
  department: { type: String, required: true },
  fee: { type: Number, required: true, min: 0 },
  availability: { type: [Date], default: [] },
  weeklyAvailability: {
    type: [{
      dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
      startTime: { type: String, required: true },
      endTime: { type: String, required: true },
    }],
    default: () => Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, startTime: '00:00', endTime: '24:00' })),
  },
});

const inventorySchema = new Schema<InventoryDocument>({
  medicine: { type: String, required: true, unique: true },
  stock: { type: Number, required: true, min: 0 },
  lowStockThreshold: { type: Number, required: true, min: 0, default: 10 },
  deductedOrderIds: [{ type: Schema.Types.ObjectId, ref: 'PharmacyOrder', default: [] }],
});

export const Department = models.Department || model<DepartmentDocument>('Department', departmentSchema);
export const Doctor = models.Doctor || model<DoctorDocument>('Doctor', doctorSchema);
export const InventoryItem = models.InventoryItem || model<InventoryDocument>('InventoryItem', inventorySchema);
