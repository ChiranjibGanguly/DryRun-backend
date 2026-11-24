import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  cancelOrder,
  getOrder,
  listOrders,
  placeOrder,
  retryPayment,
} from '../services/orderService.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();
router.use(requireAuth);

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const checkId = (id) => {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Order not found');
  return id;
};

router.post(
  '/',
  validateBody(z.object({
    addressId: z.string().uuid('Choose a delivery address'),
    paymentMethod: z.enum(['online', 'cod'], { message: 'Choose a payment method' }),
  })),
  wrap(async (req, res) => {
    res.status(201).json(await placeOrder(req.user.id, req.body));
  }),
);

router.get(
  '/',
  validateQuery(z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })),
  wrap(async (req, res) => {
    res.json(await listOrders(req.user.id, req.validQuery));
  }),
);

router.get('/:id', wrap(async (req, res) => {
  res.json({ order: await getOrder(req.user.id, checkId(req.params.id)) });
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  res.json({ order: await cancelOrder(req.user.id, checkId(req.params.id)) });
}));

router.post('/:id/payment', wrap(async (req, res) => {
  res.json(await retryPayment(req.user.id, checkId(req.params.id)));
}));

export default router;
