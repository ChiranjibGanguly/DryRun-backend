import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  createAddress,
  deleteAddress,
  listAddresses,
  updateAddress,
} from '../services/addressService.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();
router.use(requireAuth);

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const checkId = (id) => {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Address not found');
  return id;
};

const fields = {
  name: z.string().trim().min(2, 'Enter the recipient name').max(100),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
    .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number')),
  line1: z.string().trim().min(3, 'Enter the house / street').max(200),
  line2: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
  city: z.string().trim().min(2, 'Enter the city').max(100),
  state: z.string().trim().min(2, 'Enter the state').max(100),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a 6-digit PIN code'),
  isDefault: z.boolean().optional(),
};

router.get('/', wrap(async (req, res) => {
  res.json({ items: await listAddresses(req.user.id) });
}));

router.post('/', validateBody(z.object(fields)), wrap(async (req, res) => {
  res.status(201).json({ address: await createAddress(req.user.id, req.body) });
}));

router.patch(
  '/:id',
  validateBody(z.object(fields).partial().refine((a) => Object.keys(a).length > 0, 'Nothing to update')),
  wrap(async (req, res) => {
    res.json({ address: await updateAddress(req.user.id, checkId(req.params.id), req.body) });
  }),
);

router.delete('/:id', wrap(async (req, res) => {
  await deleteAddress(req.user.id, checkId(req.params.id));
  res.status(204).end();
}));

export default router;
