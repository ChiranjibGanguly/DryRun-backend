// Turns common PostgreSQL connection errors into a clear next step.
export function explainDbError(err) {
  const msg = String(err?.message || err);
  if (msg.includes('client password must be a string')) {
    return 'PostgreSQL asked for a password, but DATABASE_URL in backend/.env has none.\n' +
      'Set it as: postgresql://USER:PASSWORD@localhost:5432/dryrun';
  }
  if (err?.code === '28P01') {
    return 'PostgreSQL rejected the username or password in DATABASE_URL (backend/.env).';
  }
  if (err?.code === '3D000') {
    return 'The database in DATABASE_URL does not exist yet. Run: npm run db:create';
  }
  if (err?.code === 'ECONNREFUSED') {
    return 'Cannot connect to PostgreSQL. Is Postgres.app running on port 5432?';
  }
  return msg;
}
