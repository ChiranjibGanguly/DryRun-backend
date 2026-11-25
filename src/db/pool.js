import pg from 'pg';
import { config } from '../config.js';

// Hosted databases such as Neon need SSL: add ?sslmode=require to DATABASE_URL.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

// Serverless databases (Neon) close idle connections when they scale to zero.
// Without this handler that error would crash the server; the pool simply
// opens a new connection on the next query.
pool.on('error', (err) => {
  console.warn('Database connection closed:', err.message);
});

export const query = (text, params) => pool.query(text, params);
