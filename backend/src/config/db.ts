import mongoose from 'mongoose';
import { env } from './env';
import { Department, InventoryItem } from '../models/Clinic';
import { Appointment } from '../models/Appointment';

export const connectDatabase = async () => {
  await mongoose.connect(env.mongoUri);
  const appointmentIndexes = await Appointment.collection.indexes();
  const obsoleteSlotIndex = appointmentIndexes.find((index) =>
    index.unique
      && index.key.doctorId === 1
      && index.key.slot === 1
      && !index.partialFilterExpression,
  );
  if (obsoleteSlotIndex?.name) {
    await Appointment.collection.dropIndex(obsoleteSlotIndex.name);
  }
  await Appointment.collection.createIndex(
    { doctorId: 1, slot: 1 },
    {
      name: 'active_doctor_slot',
      unique: true,
      partialFilterExpression: { status: { $in: ['REQUESTED', 'PAYMENT_PENDING', 'CONFIRMED'] } },
    },
  );
  await Promise.all([
    Department.bulkWrite([
      { updateOne: { filter: { code: 'CARD' }, update: { $setOnInsert: { name: 'Cardiology', code: 'CARD', description: 'Heart and vascular care' } }, upsert: true } },
      { updateOne: { filter: { code: 'ORTHO' }, update: { $setOnInsert: { name: 'Orthopedics', code: 'ORTHO', description: 'Bone and joint treatment' } }, upsert: true } },
      { updateOne: { filter: { code: 'NEURO' }, update: { $setOnInsert: { name: 'Neurology', code: 'NEURO', description: 'Brain and nervous system care' } }, upsert: true } },
    ]),
    InventoryItem.bulkWrite([
      { updateOne: { filter: { medicine: 'Paracetamol 500mg' }, update: { $setOnInsert: { medicine: 'Paracetamol 500mg', stock: 120, lowStockThreshold: 20 } }, upsert: true } },
      { updateOne: { filter: { medicine: 'Amoxicillin 250mg' }, update: { $setOnInsert: { medicine: 'Amoxicillin 250mg', stock: 12, lowStockThreshold: 20 } }, upsert: true } },
      { updateOne: { filter: { medicine: 'Vitamin D3' }, update: { $setOnInsert: { medicine: 'Vitamin D3', stock: 42, lowStockThreshold: 10 } }, upsert: true } },
    ]),
  ]);
  console.log('MongoDB connected; initial clinic data is ready');
};
