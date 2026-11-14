import mongoose from 'mongoose';
import { env } from './env';
import { Department, InventoryItem } from '../models/Clinic';

export const connectDatabase = async () => {
  await mongoose.connect(env.mongoUri);
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
