// Creates the database named in DATABASE_URL if it does not exist yet.
import pg from 'pg';
import { config } from '../config.js';

const url = new URL(config.databaseUrl);
const dbName = decodeURIComponent(url.pathname.slice(1));
url.pathname = '/postgres';

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
const { rowCount } = await client.query(
  'SELECT 1 FROM pg_database WHERE datname = $1',
  [dbName],
);
if (rowCount) {
  console.log(`Database "${dbName}" already exists`);
} else {
  await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  console.log(`Created database "${dbName}"`);
}
await client.end();
