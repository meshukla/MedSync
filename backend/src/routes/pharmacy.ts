import { Router } from 'express';
import { z } from 'zod';
import { PharmacyOrder, pharmacyOrderStatuses, type PharmacyOrderDocument, type PharmacyOrderStatus } from '../models/PharmacyOrder';
import { InventoryItem } from '../models/Clinic';
import { User } from '../models/User';
import { Prescription, type PrescriptionItem } from '../models/Prescription';
import { requireAuth, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { publishAdminEvent, publishRoleEvent, publishUserEvent } from '../realtime/socket';
import { clearOrderInventoryDeductions, deductOrderInventory } from '../services/inventory';
import { recordAudit } from '../utils/audit';
import { verifyPrescriptionSignature } from '../utils/prescriptionSignature';
import { successResponse } from '../utils/response';
import { notifyRole, notifyUsers } from '../services/userNotifications';
import { cacheKeys, getOrLoadCache, invalidateCache } from '../services/redisCache';

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
  const deliveryStaff = await getOrLoadCache(cacheKeys.deliveryStaff, 120, () =>
    User.find({ role: 'deliveryBoy', isActive: true }).select('_id name').sort({ name: 1 }).lean());
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
  await recordAudit(req, {
    action: 'pharmacy.bill_generated',
    entityType: 'pharmacyOrder',
    entityId: order.id,
    details: { total: order.total, itemCount: order.items.length },
  });
  publishUserEvent(order.patientId.toString(), 'pharmacy.bill-generated', event);
  publishRoleEvent('pharmacist', 'pharmacy.bill-generated', event);
  publishAdminEvent('pharmacy.bill-generated', event);
  await notifyUsers([order.patientId.toString()], {
    event: 'pharmacy.bill-generated',
    title: 'Medicine bill generated',
    message: `Your medicine bill of ₹${order.total.toFixed(2)} is ready for payment.`,
    metadata: event,
    dedupeKey: `pharmacy-bill:${order.id}`,
    email: {
      subject: 'Your MedSync medicine bill is ready',
      text: `Your medicine bill of ₹${order.total.toFixed(2)} is ready. Sign in to MedSync to review and pay.`,
    },
  });
  return res.json(successResponse('Pharmacy bill generated after checking medicine availability.', order));
});

const transitions: Partial<Record<PharmacyOrderStatus, PharmacyOrderStatus[]>> = {
  PAID: ['PREPARING'],
  PREPARING: ['READY_FOR_PICKUP', 'READY_FOR_DISPATCH'],
};

const statusSchema = z.object({ status: z.enum(pharmacyOrderStatuses) });

router.patch('/orders/:id/status', requireAuth, requireRole('pharmacist', 'admin'), async (req: AuthenticatedRequest, res) => {
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

  let updatedOrder: PharmacyOrderDocument | null = null;
  if (parsed.data.status === 'PREPARING') {
    const deduction = await deductOrderInventory(order);
    if (!deduction.success) {
      return res.status(409).json({ success: false, message: deduction.message });
    }
    updatedOrder = await PharmacyOrder.findOneAndUpdate(
      { _id: order._id, status: 'PAID' },
      { $set: { status: 'PREPARING', stockDeductedAt: new Date() } },
      { new: true },
    );
    if (!updatedOrder) {
      const currentOrder = await PharmacyOrder.findById(order._id);
      if (currentOrder?.status === 'PREPARING' && currentOrder.stockDeductedAt) updatedOrder = currentOrder;
    }
  } else if (parsed.data.status === 'READY_FOR_DISPATCH') {
    if (!order.stockDeductedAt) {
      return res.status(409).json({ success: false, message: 'Inventory must be deducted before dispatch.' });
    }
    let deliveryAddress = order.deliveryAddress;
    if (!deliveryAddress?.trim()) {
      const patient = await User.findById(order.patientId).select('deliveryAddress');
      deliveryAddress = patient?.deliveryAddress;
    }
    if (!deliveryAddress?.trim()) {
      return res.status(409).json({ success: false, message: 'Patient delivery address is missing. Ask the patient to save an address or prepare this order for pickup.' });
    }
    updatedOrder = await PharmacyOrder.findOneAndUpdate(
      { _id: order._id, status: 'PREPARING', stockDeductedAt: { $exists: true } },
      { $set: { status: 'READY_FOR_DISPATCH', deliveryAddress } },
      { new: true },
    );
  } else if (parsed.data.status === 'READY_FOR_PICKUP') {
    if (!order.stockDeductedAt) {
      return res.status(409).json({ success: false, message: 'Inventory must be deducted before pickup.' });
    }
    updatedOrder = await PharmacyOrder.findOneAndUpdate(
      { _id: order._id, status: 'PREPARING', stockDeductedAt: { $exists: true } },
      {
        $set: {
          status: 'READY_FOR_PICKUP',
        },
      },
      { new: true },
    );
  }
  if (!updatedOrder) {
    return res.status(409).json({ success: false, message: 'The pharmacy order changed. Refresh and try again.' });
  }
  await recordAudit(req, {
    action: `pharmacy.order_${updatedOrder.status.toLowerCase()}`,
    entityType: 'pharmacyOrder',
    entityId: updatedOrder._id.toString(),
    details: { status: updatedOrder.status },
  });
  const event = { pharmacyOrderId: updatedOrder._id.toString(), patientId: updatedOrder.patientId.toString(), status: updatedOrder.status };
  publishUserEvent(order.patientId.toString(), 'pharmacy.order-status', event);
  publishRoleEvent('pharmacist', 'pharmacy.order-status', event);
  publishAdminEvent('pharmacy.order-status', event);
  if (updatedOrder.status === 'PREPARING') {
    await notifyRole('pharmacist', {
      event: 'pharmacy.preparation-required',
      title: 'Medicine preparation required',
      message: `Prepare the medicines for order ${updatedOrder._id.toString()}.`,
      metadata: event,
      dedupeKey: `pharmacy-preparation:${updatedOrder._id.toString()}`,
    });
  } else if (updatedOrder.status === 'READY_FOR_PICKUP') {
    await notifyUsers([order.patientId.toString()], {
      event: 'pharmacy.ready-for-pickup',
      title: 'Medicines ready for pickup',
      message: 'Your medicines are ready for pickup at the pharmacy.',
      metadata: event,
      dedupeKey: `pharmacy-ready-pickup-patient:${updatedOrder._id.toString()}`,
      email: {
        subject: 'Your MedSync medicines are ready for pickup',
        text: 'Your medicines are ready for pickup at the pharmacy.',
      },
    });
    await notifyRole('pharmacist', {
      event: 'pharmacy.ready-for-pickup',
      title: 'Order ready for pickup',
      message: `Order ${updatedOrder._id.toString()} is ready for pickup.`,
      metadata: event,
      dedupeKey: `pharmacy-ready-pickup-staff:${updatedOrder._id.toString()}`,
    });
  } else if (updatedOrder.status === 'READY_FOR_DISPATCH') {
    await notifyRole('pharmacist', {
      event: 'delivery.assignment-required',
      title: 'Delivery assignment required',
      message: `Order ${updatedOrder._id.toString()} is ready to be assigned for delivery.`,
      metadata: event,
      dedupeKey: `delivery-assignment-required:${updatedOrder._id.toString()}`,
    });
  }
  return res.json(successResponse('Order status updated.', updatedOrder));
});

router.post('/orders/:id/collect', requireAuth, requireRole('pharmacist', 'admin'), async (req: AuthenticatedRequest, res) => {
  const collected = await PharmacyOrder.findOneAndUpdate(
    { _id: req.params.id, status: 'READY_FOR_PICKUP' },
    { $set: { status: 'COLLECTED', collectedAt: new Date() } },
    { new: true },
  );
  if (!collected) {
    if (!await PharmacyOrder.exists({ _id: req.params.id })) {
      return res.status(404).json({ success: false, message: 'Pickup-ready order not found.' });
    }
    return res.status(409).json({ success: false, message: 'The pharmacy order changed. Refresh and try again.' });
  }
  await clearOrderInventoryDeductions(collected.id);
  await recordAudit(req, { action: 'pharmacy.order_collected', entityType: 'pharmacyOrder', entityId: collected.id });
  const event = { pharmacyOrderId: collected.id, patientId: collected.patientId.toString(), status: collected.status };
  publishUserEvent(event.patientId, 'pharmacy.order-status', event);
  publishRoleEvent('pharmacist', 'pharmacy.order-status', event);
  publishAdminEvent('pharmacy.order-collected', event);
  return res.json(successResponse('Pickup marked collected.', collected));
});

router.get('/inventory', requireAuth, requireRole('pharmacist', 'admin'), async (_req, res) => {
  const inventory = await getOrLoadCache(cacheKeys.pharmacyInventory, 30, async () => {
    const items = await InventoryItem.find().sort({ medicine: 1 }).lean();
    return items.map((item) => ({ ...item, lowStock: item.stock <= item.lowStockThreshold }));
  });
  return res.json(successResponse('Inventory loaded.', inventory));
});

const createInventorySchema = z.object({
  medicine: z.string().trim().min(2).max(120),
  stock: z.number().int().min(0),
  lowStockThreshold: z.number().int().min(0).default(10),
});

router.post('/inventory', requireAuth, requireRole('pharmacist', 'admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = createInventorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a medicine name and valid stock values.' });
  }
  const inventoryNames = await InventoryItem.find().select('medicine').lean();
  if (inventoryNames.some((item) => item.medicine.trim().toLowerCase() === parsed.data.medicine.toLowerCase())) {
    return res.status(409).json({ success: false, message: 'That medicine is already in inventory.' });
  }
  let item;
  try {
    item = await InventoryItem.create(parsed.data);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return res.status(409).json({ success: false, message: 'That medicine is already in inventory.' });
    }
    throw error;
  }
  await invalidateCache(cacheKeys.pharmacyInventory);
  await recordAudit(req, {
    action: 'pharmacy.inventory_created',
    entityType: 'inventoryItem',
    entityId: item.id,
    details: { medicine: item.medicine, openingStock: item.stock },
  });
  publishRoleEvent('pharmacist', 'pharmacy.inventory-updated', { inventoryItemId: item.id });
  publishAdminEvent('pharmacy.inventory-updated', { inventoryItemId: item.id });
  if (item.stock <= item.lowStockThreshold) {
    await notifyRole('admin', {
      event: 'inventory.low-stock',
      title: 'Low medicine stock',
      message: `${item.medicine} is low in stock (${item.stock} remaining; threshold ${item.lowStockThreshold}).`,
      metadata: { inventoryItemId: item.id, stock: item.stock, threshold: item.lowStockThreshold },
      email: {
        subject: 'MedSync low medicine stock alert',
        text: `${item.medicine} is low in stock (${item.stock} remaining; threshold ${item.lowStockThreshold}).`,
      },
    });
  }
  return res.status(201).json(successResponse('Medicine added to inventory.', item));
});

const inventorySchema = z.object({ stock: z.number().int().min(0) });

router.patch('/inventory/:id', requireAuth, requireRole('pharmacist', 'admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = inventorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Stock must be a non-negative whole number.' });
  }

  const previous = await InventoryItem.findById(req.params.id).select('medicine stock lowStockThreshold');
  if (!previous) {
    return res.status(404).json({ success: false, message: 'Inventory item not found.' });
  }
  const item = await InventoryItem.findOneAndUpdate(
    { _id: previous._id, stock: previous.stock },
    { $set: { stock: parsed.data.stock } },
    { new: true },
  ).lean();
  if (!item) {
    return res.status(409).json({ success: false, message: 'Inventory stock changed. Refresh and try again.' });
  }
  await invalidateCache(cacheKeys.pharmacyInventory);

  await recordAudit(req, {
    action: 'pharmacy.inventory_adjusted',
    entityType: 'inventoryItem',
    entityId: item._id.toString(),
    details: { newStock: item.stock },
  });
  publishRoleEvent('pharmacist', 'pharmacy.inventory-updated', { inventoryItemId: item._id.toString() });
  publishAdminEvent('pharmacy.inventory-updated', { inventoryItemId: item._id.toString() });
  if (previous.stock > previous.lowStockThreshold && item.stock <= item.lowStockThreshold) {
    await notifyRole('admin', {
      event: 'inventory.low-stock',
      title: 'Low medicine stock',
      message: `${item.medicine} is low in stock (${item.stock} remaining; threshold ${item.lowStockThreshold}).`,
      metadata: { inventoryItemId: item._id.toString(), stock: item.stock, threshold: item.lowStockThreshold },
      email: {
        subject: 'MedSync low medicine stock alert',
        text: `${item.medicine} is low in stock (${item.stock} remaining; threshold ${item.lowStockThreshold}).`,
      },
    });
  }
  return res.json(successResponse('Inventory updated.', item));
});

const restockSchema = z.object({
  quantity: z.number().int().positive().max(1_000_000),
  reason: z.string().trim().min(3).max(300),
});

router.patch('/inventory/:id/restock', requireAuth, requireRole('pharmacist', 'admin'), async (req: AuthenticatedRequest, res) => {
  const parsed = restockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter a positive restock quantity and a reason.' });
  }
  const item = await InventoryItem.findByIdAndUpdate(
    req.params.id,
    { $inc: { stock: parsed.data.quantity } },
    { new: true },
  );
  if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found.' });
  await invalidateCache(cacheKeys.pharmacyInventory);
  await recordAudit(req, {
    action: 'pharmacy.inventory_restocked',
    entityType: 'inventoryItem',
    entityId: item.id,
    details: { quantity: parsed.data.quantity, reason: parsed.data.reason, stock: item.stock },
  });
  publishRoleEvent('pharmacist', 'pharmacy.inventory-updated', { inventoryItemId: item.id });
  publishAdminEvent('pharmacy.inventory-updated', { inventoryItemId: item.id });
  return res.json(successResponse('Inventory restocked.', item));
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

  const readyOrder = await PharmacyOrder.findOne({
    _id: req.params.id,
    status: { $in: ['READY_FOR_DISPATCH', 'OUT_FOR_DELIVERY'] },
  }).select('patientId deliveryAddress assignedDeliveryId status');
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

  const oldDeliveryId = readyOrder.assignedDeliveryId?.toString();
  const reassigned = readyOrder.status === 'OUT_FOR_DELIVERY'
    && Boolean(oldDeliveryId)
    && oldDeliveryId !== parsed.data.deliveryUserId;
  if (readyOrder.status === 'OUT_FOR_DELIVERY' && !reassigned) {
    return res.status(409).json({ success: false, message: 'Choose a different delivery person to reassign this order.' });
  }
  const order = await PharmacyOrder.findOneAndUpdate(
    { _id: req.params.id, status: readyOrder.status, assignedDeliveryId: readyOrder.assignedDeliveryId },
    {
      $set: {
        assignedDeliveryId: parsed.data.deliveryUserId,
        ...(readyOrder.status === 'READY_FOR_DISPATCH' ? { status: 'OUT_FOR_DELIVERY' } : {}),
      },
    },
    { new: true },
  );
  if (!order) {
    return res.status(404).json({ success: false, message: 'Dispatch-ready order not found.' });
  }

  await recordAudit(req, {
    action: 'delivery.assigned',
    entityType: 'pharmacyOrder',
    entityId: order.id,
    details: { deliveryUserId: parsed.data.deliveryUserId },
  });
  const event = { pharmacyOrderId: order.id, patientId: order.patientId.toString(), status: order.status };
  await notifyUsers([parsed.data.deliveryUserId], {
    event: reassigned ? 'delivery.reassigned' : 'delivery.assigned',
    title: reassigned ? 'Delivery reassigned to you' : 'New delivery assigned',
    message: `Order ${order.id} is assigned to you for delivery.`,
    metadata: event,
    dedupeKey: `delivery-assigned:${order.id}:${parsed.data.deliveryUserId}`,
    email: {
      subject: reassigned ? 'MedSync delivery reassigned to you' : 'New MedSync delivery assigned',
      text: `Order ${order.id} has been assigned to you for delivery. Sign in to MedSync to view the delivery details.`,
    },
  });
  await notifyUsers([parsed.data.deliveryUserId], {
    event: 'delivery.details-available',
    title: 'New delivery address/details',
    message: `Delivery details for order ${order.id} are available in MedSync.`,
    metadata: event,
    dedupeKey: `delivery-details-available:${order.id}:${parsed.data.deliveryUserId}`,
  });
  if (reassigned && oldDeliveryId) {
    await notifyUsers([oldDeliveryId], {
      event: 'delivery.reassigned',
      title: 'Delivery reassigned',
      message: `Order ${order.id} has been reassigned to another delivery person.`,
      metadata: event,
      dedupeKey: `delivery-reassigned:${order.id}:${oldDeliveryId}:${parsed.data.deliveryUserId}`,
      email: {
        subject: 'MedSync delivery reassigned',
        text: `Order ${order.id} has been reassigned to another delivery person.`,
      },
    });
  }
  await notifyUsers([order.patientId.toString()], {
    event: 'delivery.assigned',
    title: 'Delivery assigned',
    message: reassigned ? 'Your medicine delivery has been reassigned.' : 'A delivery person has been assigned to your medicine order.',
    metadata: event,
    dedupeKey: `delivery-assigned-patient:${order.id}:${parsed.data.deliveryUserId}`,
    email: {
      subject: 'MedSync medicine delivery assigned',
      text: reassigned ? 'Your medicine delivery has been reassigned.' : 'A delivery person has been assigned to your medicine order.',
    },
  });
  publishUserEvent(parsed.data.deliveryUserId, 'delivery.assigned', event);
  publishRoleEvent('deliveryBoy', 'delivery.assigned', event);
  publishRoleEvent('pharmacist', 'delivery.assigned', event);
  publishUserEvent(order.patientId.toString(), 'delivery.assigned', event);
  publishAdminEvent('delivery.assigned', event);
  return res.json(successResponse('Delivery assigned.', order));
});

export default router;
