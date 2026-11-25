import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  getAdminOrder,
  getStats,
  listAdminOrders,
  markCodPaid,
  updateOrderStatus,
} from '../services/adminOrderService.js';
import { IMPORT_TEMPLATE, importBooksCsv } from '../services/importService.js';
import { HttpError } from '../utils/httpError.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const checkId = (id) => {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Order not found');
  return id;
};

// ---------- dashboard ----------
router.get('/stats', wrap(async (_req, res) => {
  res.json(await getStats());
}));

// ---------- orders ----------
router.get(
  '/orders',
  validateQuery(z.object({
    status: z.enum(['pending', 'placed', 'paid', 'shipped', 'delivered', 'cancelled', 'to_ship']).optional(),
    q: z.string().trim().max(100).optional().transform((v) => v || undefined),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })),
  wrap(async (req, res) => {
    res.json(await listAdminOrders(req.validQuery));
  }),
);

router.get('/orders/:id', wrap(async (req, res) => {
  res.json({ order: await getAdminOrder(checkId(req.params.id)) });
}));

router.patch(
  '/orders/:id/status',
  validateBody(z.object({
    status: z.enum(['shipped', 'delivered', 'cancelled']),
    trackingNumber: z.string().trim().max(100).optional().transform((v) => v || undefined),
    courier: z.string().trim().max(100).optional().transform((v) => v || undefined),
  })),
  wrap(async (req, res) => {
    res.json({ order: await updateOrderStatus(checkId(req.params.id), req.body) });
  }),
);

router.post('/orders/:id/mark-paid', wrap(async (req, res) => {
  res.json({ order: await markCodPaid(checkId(req.params.id)) });
}));

// ---------- CSV import ----------
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

router.get('/books/import/template', (_req, res) => {
  res.type('text/csv').attachment('pustakalay-books-template.csv').send(IMPORT_TEMPLATE);
});

// POST /api/admin/books/import?dryRun=1  (multipart field "file", a .csv)
router.post('/books/import', (req, res, next) => {
  csvUpload.single('file')(req, res, async (err) => {
    try {
      if (err?.code === 'LIMIT_FILE_SIZE') throw new HttpError(400, 'The CSV must be 2 MB or smaller');
      if (err) throw err;
      if (!req.file) throw new HttpError(400, 'Attach a CSV file in the "file" field');
      const dryRun = ['1', 'true', 'yes'].includes(String(req.query.dryRun ?? '').toLowerCase());
      res.json(await importBooksCsv(req.file.buffer.toString('utf8'), { dryRun }));
    } catch (e) {
      next(e);
    }
  });
});

export default router;
