import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

/** "https://a.com, https://b.com" -> ['https://a.com', 'https://b.com']; '*' stays '*'. */
function origins(value) {
  if (!value || value.trim() === '*') return '*';
  return value.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
}

export const config = {
  isProduction,
  port: Number(process.env.PORT) || 3000,
  corsOrigin: origins(process.env.CORS_ORIGIN),
  // Behind a proxy/load balancer (Render, Railway…) set TRUST_PROXY=1 so
  // rate limits see the real client IP.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
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

  // Rate limits (requests per window per IP).
  rateLimits: {
    windowMinutes: Number(process.env.RATE_LIMIT_WINDOW_MINUTES ?? 15),
    auth: Number(process.env.RATE_LIMIT_AUTH ?? 20), // login, register, change password
    api: Number(process.env.RATE_LIMIT_API ?? 1500), // everything else under /api
  },

  // Emails. Without RESEND_API_KEY, emails are printed to the console.
  get resendApiKey() {
    return process.env.RESEND_API_KEY || '';
  },
  emailFrom: process.env.EMAIL_FROM || 'DryRun Books <orders@example.com>',
  shopUrl: (process.env.SHOP_URL || 'http://localhost:8080').replace(/\/$/, ''),
};

/** Refuse to start in production with unsafe settings. */
export function checkProductionConfig() {
  if (!isProduction) return [];
  const problems = [];
  if (config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  if (config.corsOrigin === '*') problems.push('CORS_ORIGIN must list your web app address(es), not *');
  if (process.env.ADMIN_PASSWORD === 'Admin@12345') problems.push('Change ADMIN_PASSWORD from the default');
  return problems;
}
