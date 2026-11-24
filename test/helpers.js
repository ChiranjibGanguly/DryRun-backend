import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { createUser, signToken } from '../src/services/userService.js';

/** Starts the app on a random port; returns { base, close }. */
export async function startServer() {
  await migrate({ log: () => {} });
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

export function makeApi(base) {
  return async function api(path, { method = 'GET', body, token, form } = {}) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  };
}

export async function makeUserToken(prefix, role = 'customer') {
  const user = await createUser({
    name: `${prefix} user`,
    email: `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`,
    password: 'secret123',
    role,
  });
  return signToken(user);
}
