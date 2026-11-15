import { Payment } from '../models/Payment';
import type { PaymentDocument } from '../models/Payment';
import { getRazorpayClient } from './razorpay';

export type RefundRequestResult =
  | { success: true; payment: PaymentDocument }
  | { success: false; message: string };

export const requestFullRefund = async (
  payment: PaymentDocument,
  reason: string,
): Promise<RefundRequestResult> => {
  if (payment.status !== 'CAPTURED' || !payment.providerPaymentId) {
    return { success: false, message: 'A captured payment is required before requesting a refund.' };
  }
  if (payment.refundStatus === 'PENDING' || payment.refundStatus === 'PROCESSED') {
    return { success: true, payment };
  }
  if (payment.refundStatus === 'FAILED') {
    return { success: false, message: 'The refund request needs hospital review before it can be retried.' };
  }
  const razorpay = getRazorpayClient();

  const claimedPayment = await Payment.findOneAndUpdate(
    { _id: payment._id, status: 'CAPTURED', refundStatus: 'NOT_REQUESTED' },
    { $set: { refundStatus: 'PENDING', refundRequestedAt: new Date(), refundAmountPaise: payment.amountPaise } },
    { new: true },
  );
  if (!claimedPayment) {
    const currentPayment = await Payment.findById(payment._id);
    if (currentPayment?.refundStatus === 'PENDING' || currentPayment?.refundStatus === 'PROCESSED') {
      return { success: true, payment: currentPayment };
    }
    return { success: false, message: 'The payment refund status changed. Refresh and try again.' };
  }

  try {
    const refund = await razorpay.payments.refund(payment.providerPaymentId, {
      amount: payment.amountPaise,
      notes: { reason },
    });
    if (refund.amount !== payment.amountPaise || !refund.id) {
      throw new Error('The payment provider returned incomplete refund details.');
    }
    const updatedPayment = await Payment.findByIdAndUpdate(
      payment._id,
      {
        $set: {
          refundId: refund.id,
          refundStatus: refund.status === 'processed' ? 'PROCESSED' : 'PENDING',
          ...(refund.status === 'processed' ? { refundedAt: new Date() } : {}),
        },
      },
      { new: true },
    );
    if (!updatedPayment) throw new Error('The payment record disappeared after requesting a refund.');
    return { success: true, payment: updatedPayment };
  } catch (error) {
    await Payment.updateOne(
      { _id: payment._id, refundStatus: 'PENDING', refundId: { $exists: false } },
      { $set: { refundStatus: 'FAILED' } },
    );
    throw error;
  }
};
