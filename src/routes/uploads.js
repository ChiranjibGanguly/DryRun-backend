import { Router } from 'express';
import multer from 'multer';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { COVER_TYPES, saveCover } from '../services/coverStorage.js';
import { HttpError } from '../utils/httpError.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (COVER_TYPES[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, 'Cover must be a JPEG, PNG or WebP image'));
  },
});

const router = Router();

// POST /api/admin/uploads/cover  (multipart field "file") -> { url }
// Stored in Cloudinary when CLOUDINARY_URL is set, otherwise under /uploads.
router.post('/cover', requireAuth, requireAdmin, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'Cover must be 2 MB or smaller'));
    if (err) return next(err);
    if (!req.file) return next(new HttpError(400, 'Attach an image in the "file" field'));
    try {
      res.status(201).json({ url: await saveCover(req.file.buffer, req.file.mimetype) });
    } catch (e) {
      next(e);
    }
  });
});

export default router;
