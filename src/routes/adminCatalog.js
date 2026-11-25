import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  createAuthor,
  createBook,
  deleteBook,
  getBookById,
  listBooks,
  updateBook,
} from '../services/catalogService.js';
import { HttpError } from '../utils/httpError.js';
import { listQuerySchema } from './catalog.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const uuid = z.string().uuid('Invalid id');
const optionalText = (max) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
const paise = z.number().int('Amounts are in paise (whole numbers)').min(0).max(100_000_000);

const bookFields = {
  title: z.string().trim().min(1, 'Title is required').max(200),
  authorId: uuid.optional(),
  authorName: z.string().trim().min(1).max(120).optional(),
  description: optionalText(5000),
  isbn: z
    .string()
    .trim()
    .regex(/^[0-9Xx-]{10,17}$/, 'ISBN should be 10 or 13 digits')
    .nullable()
    .optional(),
  publisher: optionalText(120),
  language: optionalText(40),
  pages: z.number().int().min(1).max(20000).nullable().optional(),
  pricePaise: paise,
  mrpPaise: paise.nullable().optional(),
  stock: z.number().int().min(0).max(1_000_000).default(0),
  coverUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^(\/uploads\/|https?:\/\/)/, 'Cover must be an uploaded file or http(s) URL')
    .nullable()
    .optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  categorySlugs: z.array(z.string().trim().min(1)).max(10).optional(),
};

const createSchema = z
  .object(bookFields)
  .refine((b) => b.mrpPaise == null || b.mrpPaise >= b.pricePaise, {
    message: 'MRP cannot be lower than the price',
    path: ['mrpPaise'],
  });

const updateSchema = z
  .object({ ...bookFields, stock: bookFields.stock.removeDefault().optional() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const checkId = (id) => {
  if (!uuid.safeParse(id).success) throw new HttpError(404, 'Book not found');
};

router.get(
  '/books',
  validateQuery(listQuerySchema),
  wrap(async (req, res) => {
    res.json(await listBooks({ ...req.validQuery, includeInactive: true }));
  }),
);

router.get('/books/:id', wrap(async (req, res) => {
  checkId(req.params.id);
  const book = await getBookById(req.params.id, { includeInactive: true });
  if (!book) throw new HttpError(404, 'Book not found');
  res.json({ book });
}));

router.post('/books', validateBody(createSchema), wrap(async (req, res) => {
  res.status(201).json({ book: await createBook(req.body) });
}));

router.patch('/books/:id', validateBody(updateSchema), wrap(async (req, res) => {
  checkId(req.params.id);
  res.json({ book: await updateBook(req.params.id, req.body) });
}));

router.delete('/books/:id', wrap(async (req, res) => {
  checkId(req.params.id);
  await deleteBook(req.params.id);
  res.status(204).end();
}));

const authorSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  bio: optionalText(2000),
});

router.post('/authors', validateBody(authorSchema), wrap(async (req, res) => {
  res.status(201).json({ author: await createAuthor(req.body) });
}));

export default router;
