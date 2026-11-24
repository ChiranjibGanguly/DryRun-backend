// Integration tests: need DATABASE_URL pointing at a migrated database.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool, query } from '../src/db/pool.js';

let server;
let base;
const email = `test_${Date.now()}@example.com`;
const password = 'secret123';

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  await migrate({ log: () => {} });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await query('DELETE FROM users WHERE email LIKE $1', ['test_%@example.com']);
  server.close();
  await pool.end();
});

describe('auth', () => {
  let token;

  test('health check reports database ok', async () => {
    const res = await api('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.database, 'ok');
  });

  test('register creates a customer and returns a token', async () => {
    const res = await api('/auth/register', {
      method: 'POST',
      body: { name: 'Test User', email: email.toUpperCase(), password },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, email);
    assert.equal(res.body.user.role, 'customer');
    assert.equal(res.body.user.passwordHash, undefined);
  });

  test('register rejects a duplicate email', async () => {
    const res = await api('/auth/register', {
      method: 'POST',
      body: { name: 'Again', email, password },
    });
    assert.equal(res.status, 409);
  });

  test('register validates input', async () => {
    const res = await api('/auth/register', {
      method: 'POST',
      body: { name: 'X', email: 'not-an-email', password: '123' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.ok(res.body.details.length >= 2);
  });

  test('login works with correct password', async () => {
    const res = await api('/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(res.status, 200);
    token = res.body.token;
    assert.ok(token);
  });

  test('login fails with wrong password', async () => {
    const res = await api('/auth/login', { method: 'POST', body: { email, password: 'wrong-pass' } });
    assert.equal(res.status, 401);
  });

  test('me returns the logged-in user', async () => {
    const res = await api('/auth/me', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, email);
  });

  test('me rejects missing or bad tokens', async () => {
    assert.equal((await api('/auth/me')).status, 401);
    assert.equal((await api('/auth/me', { token: 'garbage' })).status, 401);
  });

  test('unknown routes return 404 JSON', async () => {
    const res = await api('/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });
});
