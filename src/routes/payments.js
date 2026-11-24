import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { confirmPayment, markPaidFromWebhook } from '../services/orderService.js';
import { isValidWebhookSignature } from '../services/razorpay.js';

const router = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

/** Which payment methods the app should offer. */
router.get('/config', (_req, res) => {
  res.json({
    online: config.onlinePaymentsEnabled,
    cod: true,
    razorpayKeyId: config.onlinePaymentsEnabled ? config.razorpayKeyId : null,
  });
});

router.post(
  '/verify',
  requireAuth,
  validateBody(z.object({
    orderId: z.string().uuid(),
    razorpayOrderId: z.string().min(1),
    razorpayPaymentId: z.string().min(1),
    razorpaySignature: z.string().min(1),
  })),
  wrap(async (req, res) => {
    res.json({ order: await confirmPayment(req.user.id, req.body) });
  }),
);

export default router;

/**
 * Razorpay webhook. Mounted with express.raw() before the JSON parser,
 * because the signature is computed over the exact raw body.
 */
export async function razorpayWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!isValidWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    const payment = event.payload?.payment?.entity;
    const razorpayOrderId = payment?.order_id ?? event.payload?.order?.entity?.id;
    if (razorpayOrderId) await markPaidFromWebhook(razorpayOrderId, payment?.id ?? null);
  }
  // Always 200 for a valid signature so Razorpay does not retry forever.
  res.json({ ok: true });
}
