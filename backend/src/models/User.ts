import { model, models, Schema, Types } from 'mongoose';

export const userRoles = ['patient', 'doctor', 'admin', 'pharmacist', 'deliveryBoy'] as const;
export type UserRole = (typeof userRoles)[number];

export type UserDocument = {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phone: string;
  deliveryAddress?: string;
  password: string;
  role: UserRole;
  isActive: boolean;
  emailVerifiedAt?: Date;
  createdAt: Date;
};

const userSchema = new Schema<UserDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    deliveryAddress: { type: String, trim: true, maxlength: 500 },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: userRoles, required: true },
    isActive: { type: Boolean, default: true },
    emailVerifiedAt: { type: Date },
  },
  { timestamps: true },
);

export const User = models.User || model<UserDocument>('User', userSchema);
