import { Router } from 'express';
import { PharmacyOrder } from '../models/PharmacyOrder';
import { requireAuth, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { publishAdminEvent, publishRoleEvent, publishUserEvent } from '../realtime/socket';
import { clearOrderInventoryDeductions } from '../services/inventory';
import { recordAudit } from '../utils/audit';
import { successResponse } from '../utils/response';
import { notifyUsers } from '../services/userNotifications';

const router = Router();

router.get('/assignments', requireAuth, requireRole('deliveryBoy', 'admin'), async (req: AuthenticatedRequest, res) => {
  const filter = req.user?.role === 'admin' ? {} : { assignedDeliveryId: req.user?.id };
  const assignments = await PharmacyOrder.find({ ...filter, status: { $in: ['OUT_FOR_DELIVERY', 'DELIVERED'] } })
    .select('patientId deliveryAddress status assignedDeliveryId createdAt items.name items.quantity')
    .populate('patientId', 'name phone')
    .sort({ createdAt: -1 })
    .lean();
  return res.json(successResponse('Assigned deliveries loaded.', assignments));
});

router.patch('/assignments/:id/complete', requireAuth, requireRole('deliveryBoy', 'admin'), async (req: AuthenticatedRequest, res) => {
  const filter = req.user?.role === 'admin'
    ? { _id: req.params.id, status: 'OUT_FOR_DELIVERY' }
    : { _id: req.params.id, assignedDeliveryId: req.user?.id, status: 'OUT_FOR_DELIVERY' };
  const delivered = await PharmacyOrder.findOneAndUpdate(
    filter,
    { $set: { status: 'DELIVERED', deliveredAt: new Date() } },
    { new: true },
  );
  if (!delivered) return res.status(404).json({ success: false, message: 'Active delivery assignment not found.' });

  await clearOrderInventoryDeductions(delivered.id);
  await recordAudit(req, { action: 'delivery.completed', entityType: 'pharmacyOrder', entityId: delivered.id });
  const event = { pharmacyOrderId: delivered.id, patientId: delivered.patientId.toString(), status: delivered.status };
  publishUserEvent(delivered.patientId.toString(), 'delivery.completed', event);
  publishRoleEvent('pharmacist', 'delivery.completed', event);
  if (delivered.assignedDeliveryId) {
    publishUserEvent(delivered.assignedDeliveryId.toString(), 'delivery.completed', event);
  }
  publishRoleEvent('deliveryBoy', 'delivery.completed', event);
  publishAdminEvent('delivery.completed', event);
  await notifyUsers([delivered.patientId.toString()], {
    event: 'delivery.completed',
    title: 'Medicines delivered',
    message: 'Your medicine order has been delivered.',
    metadata: event,
    dedupeKey: `delivery-completed-patient:${delivered.id}`,
    email: {
      subject: 'Your MedSync medicines were delivered',
      text: 'Your medicine order has been delivered.',
    },
  });
  if (delivered.assignedDeliveryId) {
    await notifyUsers([delivered.assignedDeliveryId.toString()], {
      event: 'delivery.completed',
      title: 'Delivery completed',
      message: `You completed delivery for order ${delivered.id}.`,
      metadata: event,
      dedupeKey: `delivery-completed-boy:${delivered.id}`,
    });
  }
  return res.json(successResponse('Delivery marked complete.', delivered));
});

export default router;
