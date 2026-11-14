import Razorpay from 'razorpay';
import { env } from '../config/env';

export class PaymentConfigurationError extends Error {}

export const getRazorpayClient = () => {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new PaymentConfigurationError('Razorpay is not configured.');
  }

  return new Razorpay({
    key_id: env.razorpayKeyId,
    key_secret: env.razorpayKeySecret,
  });
};
