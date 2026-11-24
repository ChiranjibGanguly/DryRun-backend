import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../utils/httpError.js';

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/**
 * Razorpay calls go through this object so tests can replace createOrder.
 */
export const razorpay = {
  /** Creates a Razorpay order; returns its id ("order_..."). */
  async createOrder({ amountPaise, receipt, notes }) {
    const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
    let res;
    try {
      res = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new HttpError(502, 'Could not reach Razorpay', { cause: err.message });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      console.error('Razorpay order creation failed', res.status, data?.error?.description);
      throw new HttpError(502, 'Razorpay could not create the payment');
    }
    return data.id;
  },
};

/** Checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key secret). */
export function isValidPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature }) {
  if (!config.razorpayKeySecret || !signature) return false;
  return safeEqualHex(hmac(config.razorpayKeySecret, `${razorpayOrderId}|${razorpayPaymentId}`), signature);
}

/** Webhook signature: HMAC_SHA256(raw body, webhook secret). */
export function isValidWebhookSignature(rawBody, signature) {
  if (!config.razorpayWebhookSecret || !signature) return false;
  return safeEqualHex(hmac(config.razorpayWebhookSecret, rawBody), signature);
}

// Exposed for tests.
export const signForTest = hmac;
