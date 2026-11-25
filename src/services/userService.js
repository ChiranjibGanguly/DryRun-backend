import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

const PUBLIC_COLUMNS = 'id, name, email, role, phone, created_at';

/** Shape a users row for API responses (never includes the password hash). */
export function toPublicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone,
    createdAt: row.created_at,
  };
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export async function createUser({ name, email, password, role = 'customer' }) {
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLUMNS}`,
      [name, email, passwordHash, role],
    );
    return toPublicUser(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists');
    throw err;
  }
}

export async function verifyCredentials(email, password) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const row = rows[0];
  const ok = row && (await bcrypt.compare(password, row.password_hash));
  if (!ok) throw new HttpError(401, 'Incorrect email or password');
  return toPublicUser(row);
}

export async function findUserById(id) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? toPublicUser(rows[0]) : null;
}

export async function changePassword(userId, currentPassword, newPassword) {
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new HttpError(401, 'Account no longer exists');
  if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
    throw new HttpError(400, 'Your current password is not correct');
  }
  if (currentPassword === newPassword) {
    throw new HttpError(400, 'Choose a password different from the current one');
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
}
