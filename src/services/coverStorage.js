import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../utils/httpError.js';

export const COVER_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/**
 * cloudinary://API_KEY:API_SECRET@CLOUD_NAME  ->  { cloudName, apiKey, apiSecret }
 * Returns null when Cloudinary is not configured (covers then go to local disk).
 */
export function parseCloudinaryUrl(value) {
  if (!value) return null;
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(value.trim());
  if (!m) throw new Error('CLOUDINARY_URL must look like cloudinary://API_KEY:API_SECRET@CLOUD_NAME');
  return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] };
}

/** Cloudinary upload signature: sha1 of the sorted params + API secret. */
export function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

async function saveLocally(buffer, mimetype) {
  const dir = path.join(config.uploadDir, 'covers');
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}${COVER_TYPES[mimetype]}`;
  await fs.writeFile(path.join(dir, name), buffer);
  return `/uploads/covers/${name}`;
}

async function saveToCloudinary(cloud, buffer, mimetype) {
  const params = { folder: config.cloudinaryFolder, timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), `cover${COVER_TYPES[mimetype]}`);
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('api_key', cloud.apiKey);
  form.append('signature', signParams(params, cloud.apiSecret));

  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${cloud.cloudName}/image/upload`, {
      method: 'POST',
      body: form,
    });
  } catch {
    throw new HttpError(502, 'Could not reach the image service. Try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.secure_url) {
    console.error('Cloudinary upload failed:', res.status, body?.error?.message);
    throw new HttpError(502, 'The image service refused the cover. Try another image.');
  }
  return body.secure_url;
}

/** Stores a cover image and returns its URL (Cloudinary https URL or /uploads/...). */
export async function saveCover(buffer, mimetype) {
  const cloud = parseCloudinaryUrl(config.cloudinaryUrl);
  return cloud ? saveToCloudinary(cloud, buffer, mimetype) : saveLocally(buffer, mimetype);
}
