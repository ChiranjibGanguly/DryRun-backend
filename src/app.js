import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool } from './db/pool.js';
import authRouter from './routes/auth.js';
import catalogRouter from './routes/catalog.js';
import adminCatalogRouter from './routes/adminCatalog.js';
import adminOrdersRouter from './routes/adminOrders.js';
import uploadsRouter from './routes/uploads.js';
import cartRouter from './routes/cart.js';
import addressesRouter from './routes/addresses.js';
import ordersRouter from './routes/orders.js';
import paymentsRouter, { razorpayWebhook } from './routes/payments.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Security headers. Covers are loaded by the web app from another origin,
  // so resources may be used cross-origin.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.corsOrigin }));

  // Needs the raw body for signature checks, so it comes before express.json().
  app.post(
    '/api/payments/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    (req, res, next) => razorpayWebhook(req, res).catch(next),
  );

  app.use(express.json({ limit: '1mb' }));

  // Rate limits per IP. Login/register get a tight limit against password guessing.
  const limiter = (limit, message) =>
    rateLimit({
      windowMs: config.rateLimits.windowMinutes * 60 * 1000,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: message }),
    });
  const authLimiter = limiter(
    config.rateLimits.auth,
    'Too many attempts. Please wait a few minutes and try again.',
  );
  app.use(['/api/auth/login', '/api/auth/register', '/api/auth/change-password'], authLimiter);
  app.use('/api', limiter(config.rateLimits.api, 'Too many requests. Please slow down.'));

  // Uploaded book covers
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', fallthrough: false }));

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'ok', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unreachable' });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api', catalogRouter);
  app.use('/api/admin/uploads', uploadsRouter);
  app.use('/api/admin', adminOrdersRouter);
  app.use('/api/admin', adminCatalogRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/addresses', addressesRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/payments', paymentsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
