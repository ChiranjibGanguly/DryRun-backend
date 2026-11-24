import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { HttpError } from '../utils/httpError.js';

const coversDir = path.join(config.uploadDir, 'covers');
fs.mkdirSync(coversDir, { recursive: true });

const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const upload = multer({
  storage: multer.diskStorage({
    destination: coversDir,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (TYPES[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, 'Cover must be a JPEG, PNG or WebP image'));
  },
});

const router = Router();

// POST /api/admin/uploads/cover  (multipart field "file") -> { url }
router.post('/cover', requireAuth, requireAdmin, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'Cover must be 2 MB or smaller'));
    if (err) return next(err);
    if (!req.file) return next(new HttpError(400, 'Attach an image in the "file" field'));
    res.status(201).json({ url: `/uploads/covers/${req.file.filename}` });
  });
});

export default router;
