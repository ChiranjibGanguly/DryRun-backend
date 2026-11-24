import { Router } from 'express';
import { z } from 'zod';
import { validateQuery } from '../middleware/validate.js';
import {
  SORT_OPTIONS,
  getBookBySlug,
  listAuthors,
  listBooks,
  listCategories,
} from '../services/catalogService.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional().transform((v) => v || undefined),
  category: z.string().trim().max(80).optional().transform((v) => v || undefined),
  sort: z.enum(SORT_OPTIONS).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

router.get('/books', validateQuery(listQuerySchema), wrap(async (req, res) => {
  res.json(await listBooks(req.validQuery));
}));

router.get('/books/:slug', wrap(async (req, res) => {
  const book = await getBookBySlug(req.params.slug);
  if (!book) throw new HttpError(404, 'Book not found');
  res.json({ book });
}));

router.get('/categories', wrap(async (_req, res) => {
  res.json({ items: await listCategories() });
}));

router.get('/authors', wrap(async (_req, res) => {
  res.json({ items: await listAuthors() });
}));

export default router;
