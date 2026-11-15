import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { requireAuth, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { Appointment } from '../models/Appointment';
import { Payment } from '../models/Payment';
import { AuditLog } from '../models/AuditLog';
import { PharmacyOrder } from '../models/PharmacyOrder';
import { Doctor } from '../models/Clinic';
import { queueAppointmentConfirmation, queueAppointmentReminder } from '../services/notifications';
import { publishAdminEvent, publishRoleEvent, publishUserEvent } from '../realtime/socket';
import { getRazorpayClient, PaymentConfigurationError } from '../services/razorpay';
import { successResponse } from '../utils/response';
import { notifyRole, notifyUsers } from '../services/userNotifications';

const router = Router();

const verifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

const safeEqualHex = (first: string, second: string) => {
  if (!/^[\da-f]+$/i.test(first) || !/^[\da-f]+$/i.test(second)) return false;
  const firstBuffer = Buffer.from(first, 'hex');
  const secondBuffer = Buffer.from(second, 'hex');
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
};

const pharmacyPaidStatuses = new Set([
  'PAID',
  'PREPARING',
  'READY_FOR_PICKUP',
  'READY_FOR_DISPATCH',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'COLLECTED',
]);

const announcePharmacyOrder = (order: { id: string; patientId: { toString(): string }; status: string; total: number }, event: string) => {
  const payload = {
    pharmacyOrderId: order.id,
    patientId: order.patientId.toString(),
    status: order.status,
    total: order.total,
  };
  publishUserEvent(payload.patientId, event, payload);
  publishRoleEvent('pharmacist', event, payload);
  publishAdminEvent(event, payload);
};

const notifyAppointmentPaymentSuccess = async (appointment: {
  id: string;
  patientId: { toString(): string };
  doctorId: { toString(): string };
  slot: Date;
}, amountPaise: number) => {
  const event = { appointmentId: appointment.id, status: 'CONFIRMED' };
  const when = appointment.slot.toLocaleString('en-IN', { timeZone: env.clinicTimeZone });
  const doctor = await Doctor.findById(appointment.doctorId).select('userId');
  await notifyUsers([appointment.patientId.toString()], {
    event: 'appointment.confirmed',
    title: 'Appointment confirmed',
    message: `Your appointment is confirmed for ${when}.`,
    metadata: event,
    dedupeKey: `appointment-confirmed-patient:${appointment.id}`,
  });
  if (doctor) {
    await notifyUsers([doctor.userId.toString()], {
      event: 'appointment.confirmed',
      title: 'Appointment confirmed',
      message: `Your appointment with the patient is confirmed for ${when}.`,
      metadata: event,
      dedupeKey: `appointment-confirmed-doctor:${appointment.id}`,
    });
  }
  await notifyUsers([appointment.patientId.toString()], {
    event: 'payment.successful',
    title: 'Payment successful',
    message: 'Your appointment payment was successful.',
    metadata: { appointmentId: appointment.id, amountPaise },
    dedupeKey: `appointment-payment-success:${appointment.id}`,
    email: { subject: 'MedSync appointment payment successful', text: 'Your appointment payment was successful.' },
  });
};

const markPharmacyOrderPaid = async (payment: NonNullable<Awaited<ReturnType<typeof Payment.findOne>>>) => {
  if (!payment.pharmacyOrderId) return false;
  const order = await PharmacyOrder.findOne({
    _id: payment.pharmacyOrderId,
    patientId: payment.patientId,
  });
  if (!order || Math.round(order.total * 100) !== payment.amountPaise) return false;

  const updatedOrder = await PharmacyOrder.findOneAndUpdate(
    { _id: order._id, status: { $in: ['BILL_GENERATED', 'PAYMENT_PENDING'] } },
    { $set: { status: 'PAID' } },
    { new: true },
  );
  let paidOrder = updatedOrder;
  if (!paidOrder) {
    const currentOrder = await PharmacyOrder.findById(order._id).select('_id patientId total status');
    if (!currentOrder || !pharmacyPaidStatuses.has(currentOrder.status)) return false;
    paidOrder = currentOrder;
  } else {
    announcePharmacyOrder(paidOrder, 'pharmacy.payment-captured');
  }
  await notifyUsers([paidOrder.patientId.toString()], {
    event: 'pharmacy.payment-successful',
    title: 'Medicine payment successful',
    message: `Your medicine payment of ₹${paidOrder.total.toFixed(2)} was successful.`,
    metadata: { pharmacyOrderId: paidOrder._id.toString(), total: paidOrder.total },
    dedupeKey: `pharmacy-payment-success:${paidOrder._id.toString()}`,
    email: {
      subject: 'MedSync medicine payment successful',
      text: `Your medicine payment of ₹${paidOrder.total.toFixed(2)} was successful.`,
    },
  });
  await notifyRole('pharmacist', {
    event: 'pharmacy.payment-successful',
    title: 'Patient completed medicine payment',
    message: `Payment was received for pharmacy order ${paidOrder._id.toString()}.`,
    metadata: { pharmacyOrderId: paidOrder._id.toString() },
    dedupeKey: `pharmacy-payment-pharmacist:${paidOrder._id.toString()}`,
  });
  return true;
};

const capturePayment = async (
  orderId: string,
  providerPaymentId: string,
  amountPaise: number,
  currency: string,
) => {
  const payment = await Payment.findOne({ providerOrderId: orderId });
  if (!payment || payment.amountPaise !== amountPaise || payment.currency !== currency) return false;

  if (payment.pharmacyOrderId) {
    const updatedPayment = await Payment.updateOne(
      { _id: payment._id, status: { $in: ['CREATED', 'FAILED', 'CAPTURED'] } },
      { $set: { status: 'CAPTURED', providerPaymentId, capturedAt: new Date() } },
    );
    if (updatedPayment.matchedCount !== 1) return false;
    return markPharmacyOrderPaid(payment);
  }

  if (!payment.appointmentId) return false;
  const appointment = await Appointment.findOne({
    _id: payment.appointmentId,
    patientId: payment.patientId,
    status: { $in: ['PAYMENT_PENDING', 'CONFIRMED'] },
  });
  if (!appointment) return false;

  let newlyConfirmed = false;
  if (appointment.status === 'PAYMENT_PENDING') {
    const updatedAppointment = await Appointment.updateOne(
      { _id: appointment._id, status: 'PAYMENT_PENDING' },
      { $set: { status: 'CONFIRMED' } },
    );
    if (updatedAppointment.modifiedCount === 1) {
      newlyConfirmed = true;
    } else {
      const currentAppointment = await Appointment.findById(appointment._id).select('status');
      if (currentAppointment?.status !== 'CONFIRMED') return false;
    }
  }

  const updatedPayment = await Payment.updateOne(
    { _id: payment._id, status: { $in: ['CREATED', 'FAILED', 'CAPTURED'] } },
    { $set: { status: 'CAPTURED', providerPaymentId, capturedAt: new Date() } },
  );
  if (updatedPayment.matchedCount !== 1) return false;

  await queueAppointmentConfirmation(appointment.id);
  await queueAppointmentReminder(appointment.id);
  await notifyAppointmentPaymentSuccess(appointment, amountPaise);

  if (newlyConfirmed) {
    const event = { appointmentId: appointment.id, status: 'CONFIRMED' };
    publishUserEvent(appointment.patientId.toString(), 'appointment.confirmed', event);
    const doctor = await Doctor.findById(appointment.doctorId).select('userId');
    if (doctor) publishUserEvent(doctor.userId.toString(), 'appointment.confirmed', event);
    publishAdminEvent('appointment.confirmed', event);
  }
  return true;
};

const checkoutSchema = z.object({ orderId: z.string().regex(/^[a-f\d]{24}$/i) });

router.post('/pharmacy/:orderId/checkout', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    return res.status(503).json({ success: false, message: 'Razorpay is not configured.' });
  }
  const parsed = checkoutSchema.safeParse({ orderId: req.params.orderId });
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid pharmacy order.' });
  }
  const order = await PharmacyOrder.findOne({
    _id: parsed.data.orderId,
    patientId: req.user?.id,
    status: { $in: ['BILL_GENERATED', 'PAYMENT_PENDING'] },
  });
  if (!order) {
    return res.status(404).json({ success: false, message: 'Unpaid pharmacy bill not found.' });
  }
  const amountPaise = Math.round(order.total * 100);
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) {
    return res.status(409).json({ success: false, message: 'This pharmacy bill has an invalid total.' });
  }

  let payment = await Payment.findOne({ pharmacyOrderId: order._id, patientId: req.user?.id });
  if (payment?.status === 'CAPTURED') {
    return res.status(409).json({ success: false, message: 'This pharmacy bill has already been paid.' });
  }
  if (payment?.status === 'CREATED' && payment.amountPaise !== amountPaise) {
    return res.status(409).json({ success: false, message: 'This pharmacy bill changed. Ask the pharmacy to refresh it before paying.' });
  }
  if (payment?.status === 'CREATED' && payment.amountPaise === amountPaise) {
    const checkout = {
      keyId: env.razorpayKeyId,
      orderId: payment.providerOrderId,
      amount: payment.amountPaise,
      currency: payment.currency,
    };
    const transitioned = await PharmacyOrder.findOneAndUpdate(
      { _id: order._id, status: 'BILL_GENERATED' },
      { $set: { status: 'PAYMENT_PENDING' } },
      { new: true },
    );
    if (transitioned) announcePharmacyOrder(transitioned, 'pharmacy.payment-pending');
    return res.json(successResponse('Pharmacy checkout loaded.', checkout));
  }

  let providerOrder;
  try {
    providerOrder = await getRazorpayClient().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `pharmacy-${order.id}`,
      notes: { pharmacyOrderId: order.id, patientId: req.user?.id || '' },
    });
  } catch (error) {
    if (error instanceof PaymentConfigurationError) {
      return res.status(503).json({ success: false, message: 'Razorpay is not configured.' });
    }
    throw error;
  }

  if (payment) {
    payment = await Payment.findOneAndUpdate(
      { _id: payment._id, status: 'FAILED' },
      {
        $set: {
          providerOrderId: providerOrder.id,
          amountPaise,
          currency: 'INR',
          status: 'CREATED',
        },
        $unset: { providerPaymentId: '', capturedAt: '' },
      },
      { new: true },
    );
    if (!payment) {
      const currentPayment = await Payment.findOne({ pharmacyOrderId: order._id });
      if (currentPayment?.status === 'CREATED') payment = currentPayment;
      else return res.status(409).json({ success: false, message: 'The pharmacy payment changed. Refresh and try again.' });
    }
  } else {
    try {
      payment = await Payment.create({
        patientId: req.user?.id,
        pharmacyOrderId: order._id,
        providerOrderId: providerOrder.id,
        amountPaise,
        currency: 'INR',
        status: 'CREATED',
        idempotencyKey: `pharmacy:${order.id}`,
      });
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) throw error;
      payment = await Payment.findOne({ pharmacyOrderId: order._id });
      if (!payment || payment.status !== 'CREATED' || payment.amountPaise !== amountPaise) {
        return res.status(409).json({ success: false, message: 'The pharmacy payment changed. Refresh and try again.' });
      }
    }
  }

  const transitioned = await PharmacyOrder.findOneAndUpdate(
    { _id: order._id, status: 'BILL_GENERATED' },
    { $set: { status: 'PAYMENT_PENDING' } },
    { new: true },
  );
  if (transitioned) announcePharmacyOrder(transitioned, 'pharmacy.payment-pending');
  else if (order.status === 'BILL_GENERATED') {
    const currentOrder = await PharmacyOrder.findById(order._id).select('status');
    if (currentOrder?.status !== 'PAYMENT_PENDING') {
      return res.status(409).json({ success: false, message: 'The pharmacy order changed. Refresh and try again.' });
    }
  }

  return res.status(201).json(successResponse('Pharmacy checkout created.', {
    keyId: env.razorpayKeyId,
    orderId: payment.providerOrderId,
    amount: payment.amountPaise,
    currency: payment.currency,
  }));
});

router.post('/verify', requireAuth, requireRole('patient'), async (req: AuthenticatedRequest, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid payment verification payload.' });
  }

  const { razorpay_order_id: orderId, razorpay_payment_id: providerPaymentId, razorpay_signature: signature } = parsed.data;
  const payment = await Payment.findOne({ providerOrderId: orderId, patientId: req.user?.id });
  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment order not found.' });
  }
  if (payment.status === 'CAPTURED') {
    if (payment.appointmentId) {
      await queueAppointmentConfirmation(payment.appointmentId.toString());
      await queueAppointmentReminder(payment.appointmentId.toString());
      const appointment = await Appointment.findOne({
        _id: payment.appointmentId,
        patientId: payment.patientId,
        status: 'CONFIRMED',
      }).select('_id patientId doctorId slot');
      if (appointment) {
        await notifyAppointmentPaymentSuccess(appointment, payment.amountPaise);
      }
    }
    if (payment.pharmacyOrderId && !await markPharmacyOrderPaid(payment)) {
      return res.status(409).json({ success: false, message: 'Pharmacy order is not ready to be marked paid.' });
    }
    return res.json(successResponse('Payment already verified.'));
  }

  if (!env.razorpayKeySecret) {
    return res.status(503).json({ success: false, message: 'Razorpay is not configured.' });
  }
  const expectedSignature = createHmac('sha256', env.razorpayKeySecret)
    .update(`${orderId}|${providerPaymentId}`)
    .digest('hex');
  if (!safeEqualHex(signature, expectedSignature)) {
    return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
  }

  let razorpayPayment;
  try {
    razorpayPayment = await getRazorpayClient().payments.fetch(providerPaymentId);
  } catch (error) {
    if (error instanceof PaymentConfigurationError) {
      return res.status(503).json({ success: false, message: 'Razorpay is not configured.' });
    }
    throw error;
  }

  const amountPaise = Number(razorpayPayment.amount);
  if (razorpayPayment.order_id !== orderId
    || !Number.isSafeInteger(amountPaise)
    || amountPaise !== payment.amountPaise
    || razorpayPayment.currency !== payment.currency) {
    return res.status(400).json({ success: false, message: 'Payment details do not match the order.' });
  }
  if (razorpayPayment.status !== 'captured') {
    return res.status(202).json({ success: true, message: 'Payment is awaiting capture confirmation.' });
  }

  const captured = await capturePayment(
    orderId,
    providerPaymentId,
    amountPaise,
    razorpayPayment.currency,
  );
  if (!captured) {
    return res.status(409).json({
      success: false,
      message: payment.pharmacyOrderId
        ? 'Pharmacy order could not be marked paid.'
        : 'Appointment is no longer available for confirmation.',
    });
  }
  return res.json(successResponse(payment.pharmacyOrderId ? 'Pharmacy payment verified.' : 'Payment verified. Appointment confirmed.'));
});

router.post('/webhook', async (req, res) => {
  if (!env.razorpayWebhookSecret) {
    return res.status(503).json({ success: false, message: 'Razorpay webhook is not configured.' });
  }
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ success: false, message: 'Expected raw webhook body.' });
  }

  const signature = req.header('x-razorpay-signature') || '';
  const expectedSignature = createHmac('sha256', env.razorpayWebhookSecret).update(req.body).digest('hex');
  if (!safeEqualHex(signature, expectedSignature)) {
    return res.status(400).json({ success: false, message: 'Invalid webhook signature.' });
  }

  let event: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number; currency?: string } };
      refund?: { entity?: { id?: string; payment_id?: string; amount?: number } };
    };
  };
  try {
    event = JSON.parse(req.body.toString('utf8')) as typeof event;
  } catch {
    return res.status(400).json({ success: false, message: 'Invalid webhook payload.' });
  }

  const refundEntity = event.payload?.refund?.entity;
  if ((event.event === 'refund.processed' || event.event === 'refund.failed') && refundEntity?.id) {
    const payment = await Payment.findOne({
      $or: [
        { refundId: refundEntity.id },
        ...(refundEntity.payment_id ? [{ providerPaymentId: refundEntity.payment_id }] : []),
      ],
    });
    if (payment) {
      const refundStatus = event.event === 'refund.processed' ? 'PROCESSED' : 'FAILED';
      const updatedPayment = await Payment.findOneAndUpdate(
        { _id: payment._id, refundStatus: { $ne: 'PROCESSED' } },
        { $set: { refundId: refundEntity.id, refundStatus, ...(refundStatus === 'PROCESSED' ? { refundedAt: new Date() } : {}) } },
        { new: true },
      );
      if (updatedPayment) {
        const eventPayload = {
          appointmentId: updatedPayment.appointmentId?.toString(),
          refundStatus: updatedPayment.refundStatus,
          amountPaise: refundEntity.amount || updatedPayment.refundAmountPaise,
        };
        publishUserEvent(updatedPayment.patientId.toString(), 'appointment.refund-status', eventPayload);
        publishAdminEvent('appointment.refund-status', eventPayload);
        await AuditLog.create({
          actorRole: 'system',
          action: `appointment.refund_${refundStatus.toLowerCase()}`,
          entityType: 'payment',
          entityId: updatedPayment.id,
          details: eventPayload,
        });
      }
    }
    return res.json(successResponse('Refund webhook event acknowledged.'));
  }

  const paymentEntity = event.payload?.payment?.entity;
  if (!paymentEntity?.order_id || !paymentEntity.id) {
    return res.json(successResponse('Webhook event acknowledged.'));
  }

  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    if (typeof paymentEntity.amount !== 'number' || typeof paymentEntity.currency !== 'string') {
      return res.status(400).json({ success: false, message: 'Webhook payment details are incomplete.' });
    }
    await capturePayment(paymentEntity.order_id, paymentEntity.id, paymentEntity.amount, paymentEntity.currency);
  } else if (event.event === 'payment.failed') {
    const updated = await Payment.updateOne(
      { providerOrderId: paymentEntity.order_id, status: 'CREATED' },
      { $set: { status: 'FAILED' } },
    );
    if (updated.modifiedCount === 1 || await Payment.exists({
      providerOrderId: paymentEntity.order_id,
      status: 'FAILED',
    })) {
      const payment = await Payment.findOne({ providerOrderId: paymentEntity.order_id }).select('appointmentId pharmacyOrderId patientId');
      if (payment) {
        if (payment.pharmacyOrderId) {
          const eventPayload = { pharmacyOrderId: payment.pharmacyOrderId.toString(), status: 'PAYMENT_FAILED' };
          publishUserEvent(payment.patientId.toString(), 'pharmacy.payment-failed', eventPayload);
          publishRoleEvent('pharmacist', 'pharmacy.payment-failed', eventPayload);
          publishAdminEvent('pharmacy.payment-failed', eventPayload);
          await notifyUsers([payment.patientId.toString()], {
            event: 'pharmacy.payment-failed',
            title: 'Medicine payment failed',
            message: 'Your medicine order payment could not be completed. Please try again.',
            metadata: eventPayload,
            dedupeKey: `pharmacy-payment-failed-patient:${payment.pharmacyOrderId}`,
            email: {
              subject: 'MedSync medicine payment failed',
              text: 'Your medicine order payment could not be completed. Sign in to MedSync to try again.',
            },
          });
          await notifyRole('admin', {
            event: 'payment.failed',
            title: 'Medicine payment failed',
            message: `Payment failed for pharmacy order ${payment.pharmacyOrderId}.`,
            metadata: eventPayload,
            dedupeKey: `pharmacy-payment-failed-admin:${payment.pharmacyOrderId}`,
            email: {
              subject: 'MedSync medicine payment failure',
              text: 'A medicine order payment failed. Review the administration dashboard for details.',
            },
          });
        } else if (payment.appointmentId) {
          const eventPayload = { appointmentId: payment.appointmentId.toString(), status: 'PAYMENT_FAILED' };
          const appointment = await Appointment.findById(payment.appointmentId).select('patientId');
          if (appointment) publishUserEvent(appointment.patientId.toString(), 'payment.failed', eventPayload);
          publishAdminEvent('payment.failed', eventPayload);
          if (appointment) {
            await notifyUsers([appointment.patientId.toString()], {
              event: 'payment.failed',
              title: 'Appointment payment failed',
              message: 'Your appointment payment could not be completed. Please try again.',
              metadata: eventPayload,
              dedupeKey: `appointment-payment-failed-patient:${payment.appointmentId}`,
              email: {
                subject: 'MedSync appointment payment failed',
                text: 'Your appointment payment could not be completed. Sign in to MedSync to try again.',
              },
            });
          }
          await notifyRole('admin', {
            event: 'payment.failed',
            title: 'Appointment payment failed',
            message: `Payment failed for appointment ${payment.appointmentId}.`,
            metadata: eventPayload,
            dedupeKey: `appointment-payment-failed-admin:${payment.appointmentId}`,
            email: {
              subject: 'MedSync appointment payment failure',
              text: 'An appointment payment failed. Review the administration dashboard for details.',
            },
          });
        }
      }
    }
  }

  return res.json(successResponse('Webhook event acknowledged.'));
});

export default router;
