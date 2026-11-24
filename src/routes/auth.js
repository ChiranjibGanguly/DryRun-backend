import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  createUser,
  findUserById,
  signToken,
  verifyCredentials,
} from '../services/userService.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();

const email = z.string().trim().toLowerCase().email('Enter a valid email address');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
  email,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password must be at most 72 characters'),
});

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
});

router.post('/register', validateBody(registerSchema), async (req, res, next) => {
  try {
    const user = await createUser(req.body);
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    next(err);
  }
});

router.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const user = await verifyCredentials(req.body.email, req.body.password);
    res.json({ token: signToken(user), user });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) throw new HttpError(401, 'Account no longer exists');
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

export default router;
