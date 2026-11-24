import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // Book covers are stored here and served at /uploads (Cloudinary later).
  uploadDir: path.resolve(process.env.UPLOAD_DIR || 'uploads'),

  // Shipping: flat fee, free at or above the minimum order value (paise).
  shippingFeePaise: Number(process.env.SHIPPING_FEE_PAISE ?? 4900),
  freeShippingMinPaise: Number(process.env.FREE_SHIPPING_MIN_PAISE ?? 49900),

  // Razorpay keys are read when used, so they can be set or changed without
  // touching code. Online payment is off until both keys are set.
  get razorpayKeyId() {
    return process.env.RAZORPAY_KEY_ID || '';
  },
  get razorpayKeySecret() {
    return process.env.RAZORPAY_KEY_SECRET || '';
  },
  get razorpayWebhookSecret() {
    return process.env.RAZORPAY_WEBHOOK_SECRET || '';
  },
  get onlinePaymentsEnabled() {
    return Boolean(this.razorpayKeyId && this.razorpayKeySecret);
  },
};
