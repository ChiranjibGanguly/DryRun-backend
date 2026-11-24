import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  addToCart,
  clearCart,
  getCart,
  removeFromCart,
  setCartQuantity,
} from '../services/cartService.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();
router.use(requireAuth);

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const uuid = z.string().uuid('Invalid book id');
const bookIdParam = (id) => {
  if (!uuid.safeParse(id).success) throw new HttpError(404, 'This book is not in your cart');
  return id;
};

router.get('/', wrap(async (req, res) => {
  res.json(await getCart(req.user.id));
}));

router.post(
  '/items',
  validateBody(z.object({ bookId: uuid, quantity: z.number().int().min(1).max(20).default(1) })),
  wrap(async (req, res) => {
    res.status(201).json(await addToCart(req.user.id, req.body.bookId, req.body.quantity));
  }),
);

router.patch(
  '/items/:bookId',
  validateBody(z.object({ quantity: z.number().int().min(0).max(20) })),
  wrap(async (req, res) => {
    res.json(await setCartQuantity(req.user.id, bookIdParam(req.params.bookId), req.body.quantity));
  }),
);

router.delete('/items/:bookId', wrap(async (req, res) => {
  res.json(await removeFromCart(req.user.id, bookIdParam(req.params.bookId)));
}));

router.delete('/', wrap(async (req, res) => {
  res.json(await clearCart(req.user.id));
}));

export default router;
