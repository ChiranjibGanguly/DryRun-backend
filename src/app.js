import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { pool } from './db/pool.js';
import authRouter from './routes/auth.js';
import catalogRouter from './routes/catalog.js';
import adminCatalogRouter from './routes/adminCatalog.js';
import uploadsRouter from './routes/uploads.js';
import cartRouter from './routes/cart.js';
import addressesRouter from './routes/addresses.js';
import ordersRouter from './routes/orders.js';
import paymentsRouter, { razorpayWebhook } from './routes/payments.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));

  // Needs the raw body for signature checks, so it comes before express.json().
  app.post(
    '/api/payments/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    (req, res, next) => razorpayWebhook(req, res).catch(next),
  );

  app.use(express.json({ limit: '1mb' }));

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
  app.use('/api/admin', adminCatalogRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/addresses', addressesRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/payments', paymentsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
