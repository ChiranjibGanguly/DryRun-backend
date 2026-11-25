// Security: headers, login rate limit, change password, production checks.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

// Low limit for this test file only (read when the app module loads).
process.env.RATE_LIMIT_AUTH = '3';

const { makeApi, startServer } = await import('./helpers.js');
const { pool, query } = await import('../src/db/pool.js');
const { createUser, signToken } = await import('../src/services/userService.js');

let server;
let api;
const email = `sectest_${Date.now()}@example.com`;
let token;

before(async () => {
  server = await startServer();
  api = makeApi(server.base);
  token = signToken(await createUser({ name: 'Sec User', email, password: 'oldpass123' }));
});

after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'sectest_%@example.com'");
  await server.close();
  await pool.end();
});

test('security headers are set and x-powered-by is hidden', async () => {
  const res = await api('/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('strict-transport-security'));
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
});

test('change password: checks the current one, then the new one works', async () => {
  const wrong = await api('/api/auth/change-password', {
    method: 'POST', token, body: { currentPassword: 'nope', newPassword: 'newpass123' },
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /current password is not correct/);

  const short = await api('/api/auth/change-password', {
    method: 'POST', token, body: { currentPassword: 'oldpass123', newPassword: 'short' },
  });
  assert.equal(short.status, 400);

  const ok = await api('/api/auth/change-password', {
    method: 'POST', token, body: { currentPassword: 'oldpass123', newPassword: 'newpass123' },
  });
  assert.equal(ok.status, 200);
  assert.equal((await api('/api/auth/change-password', { method: 'POST', body: {} })).status, 429,
    'fourth attempt from this IP is rate limited');
});

test('login is rate limited per IP', async () => {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password: 'newpass123' } });
  assert.equal(res.status, 429);
  assert.match(res.body.error, /Too many attempts/);
  assert.ok(res.headers.get('retry-after') || res.headers.get('ratelimit'));
});

test('other API routes are not affected by the login limit', async () => {
  assert.equal((await api('/api/categories')).status, 200);
});

test('production refuses unsafe settings', async () => {
  const { stdout, stderr, code } = await new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(process.execPath, ['src/server.js'], {
        env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'short', CORS_ORIGIN: '*', ADMIN_PASSWORD: 'Admin@12345', PORT: '0' },
        timeout: 5000,
      }, (err, out, errOut) => resolve({ stdout: out, stderr: errOut, code: err?.code }));
    });
  });
  assert.equal(code, 1, stdout);
  assert.match(stderr, /JWT_SECRET must be at least 32 characters/);
  assert.match(stderr, /CORS_ORIGIN must list/);
  assert.match(stderr, /Change ADMIN_PASSWORD/);
});
