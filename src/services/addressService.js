import { pool, query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

const COLUMNS = 'id, name, phone, line1, line2, city, state, pincode, is_default, created_at';

export function toAddress(r) {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    line1: r.line1,
    line2: r.line2,
    city: r.city,
    state: r.state,
    pincode: r.pincode,
    isDefault: r.is_default,
  };
}

export async function listAddresses(userId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at`,
    [userId],
  );
  return rows.map(toAddress);
}

export async function getAddress(userId, id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM addresses WHERE user_id = $1 AND id = $2`, [userId, id]);
  if (!rows[0]) throw new HttpError(404, 'Address not found');
  return toAddress(rows[0]);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createAddress(userId, a) {
  return withClient(async (client) => {
    const { rows: existing } = await client.query('SELECT 1 FROM addresses WHERE user_id = $1 LIMIT 1', [userId]);
    const makeDefault = a.isDefault || existing.length === 0;
    if (makeDefault) await client.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId]);
    const { rows } = await client.query(
      `INSERT INTO addresses (user_id, name, phone, line1, line2, city, state, pincode, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [userId, a.name, a.phone, a.line1, a.line2 ?? null, a.city, a.state, a.pincode, makeDefault],
    );
    return toAddress(rows[0]);
  });
}

export async function updateAddress(userId, id, a) {
  await getAddress(userId, id);
  return withClient(async (client) => {
    if (a.isDefault) await client.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId]);
    const fields = { name: 'name', phone: 'phone', line1: 'line1', line2: 'line2', city: 'city', state: 'state', pincode: 'pincode' };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(fields)) {
      if (a[k] !== undefined) {
        vals.push(a[k]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (a.isDefault) sets.push('is_default = true');
    if (sets.length) {
      vals.push(userId, id);
      await client.query(
        `UPDATE addresses SET ${sets.join(', ')} WHERE user_id = $${vals.length - 1} AND id = $${vals.length}`,
        vals,
      );
    }
    const { rows } = await client.query(`SELECT ${COLUMNS} FROM addresses WHERE id = $1`, [id]);
    return toAddress(rows[0]);
  });
}

export async function deleteAddress(userId, id) {
  const address = await getAddress(userId, id);
  await withClient(async (client) => {
    await client.query('DELETE FROM addresses WHERE id = $1', [id]);
    if (address.isDefault) {
      // Promote the oldest remaining address.
      await client.query(
        `UPDATE addresses SET is_default = true
         WHERE id = (SELECT id FROM addresses WHERE user_id = $1 ORDER BY created_at LIMIT 1)`,
        [userId],
      );
    }
  });
}
