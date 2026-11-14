import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { PrescriptionDocument } from '../models/Prescription';

const signaturePayload = (prescription: Pick<
  PrescriptionDocument,
  'appointmentId' | 'patientId' | 'doctorId' | 'doctorName' | 'items' | 'notes' | 'digitalSignature'
>) => ({
  appointmentId: prescription.appointmentId.toString(),
  patientId: prescription.patientId.toString(),
  doctorId: prescription.doctorId.toString(),
  doctorName: prescription.doctorName,
  signedBy: prescription.digitalSignature.signedBy.toString(),
  signedByName: prescription.digitalSignature.signedByName,
  signedAt: prescription.digitalSignature.signedAt.toISOString(),
  items: prescription.items.map((item) => ({
    name: item.name,
    dosage: item.dosage,
    frequency: item.frequency,
    duration: item.duration,
    quantity: item.quantity,
    instructions: item.instructions,
  })),
  notes: prescription.notes || '',
});

export const signPrescription = (prescription: Parameters<typeof signaturePayload>[0]) =>
  createHmac('sha256', env.prescriptionSigningSecret)
    .update(JSON.stringify(signaturePayload(prescription)))
    .digest('hex');

export const verifyPrescriptionSignature = (prescription: PrescriptionDocument) => {
  if (prescription.digitalSignature.algorithm !== 'HMAC-SHA256') return false;
  const expected = signPrescription(prescription);
  const actual = prescription.digitalSignature.value;
  if (!/^[\da-f]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
};
