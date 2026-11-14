import { Router } from 'express';
import { z } from 'zod';
import { PharmacyOrder, pharmacyOrderStatuses, type PharmacyOrderDocument, type PharmacyOrderStatus } from '../models/PharmacyOrder';
import { InventoryItem } from '../models/Clinic';
import { User } from '../models/User';
import { Prescription, type PrescriptionItem } from '../models/Prescription';
import { requireAuth, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { publishAdminEvent, publishRoleEvent, publishUserEvent } from '../realtime/socket';
import { verifyPrescriptionSignature } from '../utils/prescriptionSignature';
import { successResponse } from '../utils/response';

const router = Router();

router.get('/orders', requireAuth, requireRole('pharmacist', 'admin'), async (_req, res) => {
  const orders = await PharmacyOrder.find()
    .populate('patientId', 'name phone deliveryAddress')
    .populate('prescriptionId', 'doctorName notes digitalSignature')
    .sort({ createdAt: -1 })
    .lean();
  return res.json(successResponse('Pharmacy orders loaded.', orders));
});

router.get('/delivery-staff', requireAuth, requireRole('pharmacist', 'admin'), async (_req, res) => {
  const deliveryStaff = await User.find({ role: 'deliveryBoy', isActive: true }).select('_id name').sort({ name: 1 }).lean();
  return res.json(successResponse('Delivery staff loaded.', deliveryStaff));
});

const billSchema = z.object({
  unitPrices: z.array(z.number().positive().max(1_000_000)).min(1).max(30),
});

router.patch('/orders/:id/bill', requireAuth, requireRole('pharmacist', 'admin'), async (req, res) => {
  const parsed = billSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a positive unit price for every prescribed medicine.' });
  }
  const order = await PharmacyOrder.findOne({ _id: req.params.id, status: 'PRESCRIPTION_RECEIVED' });
  if (!order) {
    return res.status(404).json({ success: false, message: 'Prescription order not found or already billed.' });
  }
  if (order.items.length !== parsed.data.unitPrices.length) {
    return res.status(400).json({ success: false, message: 'Provide a price for every medicine in the prescription.' });
  }
  const prescription = order.prescriptionId ? await Prescription.findById(order.prescriptionId) : null;
  if (!prescription || !verifyPrescriptionSignature(prescription)
    || prescription.patientId.toString() !== order.patientId.toString()
    || prescription.appointmentId.toString() !== order.appointmentId?.toString()
    || prescription.items.length !== order.items.length
    || prescription.items.some((item: PrescriptionItem, index: number) => {
      const orderItem = order.items[index] as PharmacyOrderDocument['items'][number];
      return item.name !== orderItem.name
        || item.quantity !== orderItem.quantity
        || item.dosage !== orderItem.dosage
        || item.frequency !== orderItem.frequency
        || item.duration !== orderItem.duration
        || (item.instructions || '') !== (orderItem.instructions || '');
    })) {
    return res.status(409).json({ success: false, message: 'The signed prescription could not be verified. Contact the hospital administrator.' });
  }

  const inventory = await InventoryItem.find().select('medicine stock').lean();
  const stockByMedicine = new Map(inventory.map((item) => [item.medicine.trim().toLowerCase(), item.stock]));
  const requiredByMedicine = new Map<string, number>();
  for (const item of order.items) {
    const medicine = item.name.trim().toLowerCase();
    requiredByMedicine.set(medicine, (requiredByMedicine.get(medicine) || 0) + item.quantity);
  }
  for (const [medicine, required] of requiredByMedicine) {
    const available = stockByMedicine.get(medicine);
    if (available === undefined) {
      return res.status(409).json({ success: false, message: `${medicine} is not listed in pharmacy inventory.` });
    }
    if (available < required) {
      return res.status(409).json({ success: false, message: `Insufficient stock for ${medicine}.` });
    }
  }

  order.items.forEach((item: PharmacyOrderDocument['items'][number], index: number) => { item.price = parsed.data.unitPrices[index] });
  order.total = order.items.reduce((sum: number, item: PharmacyOrderDocument['items'][number]) => sum + item.quantity * item.price, 0);
  order.status = 'BILL_GENERATED';
  await order.save();
  const event = { pharmacyOrderId: order.id, patientId: order.patientId.toString(), status: order.status, total: order.total };
  publishUserEvent(order.patientId.toString(), 'pharmacy.bill-generated', event);
  publishAdminEvent('pharmacy.bill-generated', event);
  return res.json(successResponse('Pharmacy bill generated after checking medicine availability.', order));
});

const transitions: Partial<Record<PharmacyOrderStatus, PharmacyOrderStatus[]>> = {
  PAID: ['PREPARING'],
  PREPARING: ['READY_FOR_PICKUP', 'READY_FOR_DISPATCH'],
  READY_FOR_PICKUP: ['COLLECTED'],
};

const statusSchema = z.object({ status: z.enum(pharmacyOrderStatuses) });

router.patch('/orders/:id/status', requireAuth, requireRole('pharmacist', 'admin'), async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid order status.' });
  }

  const order = await PharmacyOrder.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }
  const currentStatus = pharmacyOrderStatuses.find((status) => status === order.status);
  if (!currentStatus || !transitions[currentStatus]?.includes(parsed.data.status)) {
    return res.status(409).json({ success: false, message: 'That order status transition is not allowed.' });
  }

  order.status = parsed.data.status;
  await order.save();
  const event = { pharmacyOrderId: order.id, patientId: order.patientId.toString(), status: order.status };
  publishUserEvent(order.patientId.toString(), 'pharmacy.order-status', event);
  publishAdminEvent('pharmacy.order-status', event);
  return res.json(successResponse('Order status updated.', order));
});

router.get('/inventory', requireAuth, requireRole('pharmacist', 'admin'), async (_req, res) => {
  const inventory = await InventoryItem.find().sort({ medicine: 1 }).lean();
  return res.json(successResponse('Inventory loaded.', inventory.map((item) => ({
    ...item,
    lowStock: item.stock <= item.lowStockThreshold,
  }))));
});

const createInventorySchema = z.object({
  medicine: z.string().trim().min(2).max(120),
  stock: z.number().int().min(0),
  lowStockThreshold: z.number().int().min(0).default(10),
});

router.post('/inventory', requireAuth, requireRole('pharmacist', 'admin'), async (req, res) => {
  const parsed = createInventorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a medicine name and valid stock values.' });
  }
  try {
    const item = await InventoryItem.create(parsed.data);
    return res.status(201).json(successResponse('Medicine added to inventory.', item));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return res.status(409).json({ success: false, message: 'That medicine is already in inventory.' });
    }
    throw error;
  }
});

const inventorySchema = z.object({ stock: z.number().int().min(0) });

router.patch('/inventory/:id', requireAuth, requireRole('pharmacist', 'admin'), async (req, res) => {
  const parsed = inventorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Stock must be a non-negative whole number.' });
  }

  const item = await InventoryItem.findByIdAndUpdate(req.params.id, { $set: { stock: parsed.data.stock } }, { new: true }).lean();
  if (!item) {
    return res.status(404).json({ success: false, message: 'Inventory item not found.' });
  }

  return res.json(successResponse('Inventory updated.', item));
});

const assignSchema = z.object({ deliveryUserId: z.string().regex(/^[a-f\d]{24}$/i) });

router.patch('/orders/:id/assign', requireAuth, requireRole('pharmacist', 'admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid delivery assignment.' });
  }
  if (!await User.exists({ _id: parsed.data.deliveryUserId, role: 'deliveryBoy', isActive: true })) {
    return res.status(404).json({ success: false, message: 'Active delivery account not found.' });
  }

  const readyOrder = await PharmacyOrder.findOne({ _id: req.params.id, status: 'READY_FOR_DISPATCH' })
    .select('patientId deliveryAddress');
  if (!readyOrder) {
    return res.status(404).json({ success: false, message: 'Dispatch-ready order not found.' });
  }
  if (!readyOrder.deliveryAddress?.trim()) {
    const patient = await User.findById(readyOrder.patientId).select('deliveryAddress');
    if (!patient?.deliveryAddress?.trim()) {
      return res.status(409).json({ success: false, message: 'Patient delivery address is missing. Ask the patient to update it.' });
    }
    readyOrder.deliveryAddress = patient.deliveryAddress;
    await readyOrder.save();
  }

  const order = await PharmacyOrder.findOneAndUpdate(
    { _id: req.params.id, status: 'READY_FOR_DISPATCH' },
    { $set: { assignedDeliveryId: parsed.data.deliveryUserId, status: 'OUT_FOR_DELIVERY' } },
    { new: true },
  );
  if (!order) {
    return res.status(404).json({ success: false, message: 'Dispatch-ready order not found.' });
  }

  const event = { pharmacyOrderId: order.id, patientId: order.patientId.toString(), status: order.status };
  publishUserEvent(parsed.data.deliveryUserId, 'delivery.assigned', event);
  publishRoleEvent('deliveryBoy', 'delivery.assigned', event);
  publishUserEvent(order.patientId.toString(), 'delivery.assigned', event);
  publishAdminEvent('delivery.assigned', event);
  return res.json(successResponse('Delivery assigned.', order));
});

export default router;
