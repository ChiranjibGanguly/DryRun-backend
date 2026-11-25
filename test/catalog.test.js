// Integration tests for the catalogue and admin book API.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { pool, query } from '../src/db/pool.js';
import { makeApi, makeUserToken, startServer } from './helpers.js';

const tag = `zq${Date.now().toString(36)}`; // unique word for this run
const catSlug = `cat-${tag}`;
let server;
let api;
let adminToken;
let customerToken;
const created = [];
const uploaded = [];

before(async () => {
  server = await startServer();
  api = makeApi(`${server.base}`);
  adminToken = await makeUserToken('cattest_admin', 'admin');
  customerToken = await makeUserToken('cattest_customer');
  await query('INSERT INTO categories (name, slug) VALUES ($1, $2)', [`Test ${tag}`, catSlug]);
});

after(async () => {
  for (const url of uploaded) {
    await fs.rm(path.join(config.uploadDir, url.replace('/uploads/', '')), { force: true });
  }
  if (created.length) await query('DELETE FROM books WHERE id = ANY($1)', [created]);
  await query('DELETE FROM categories WHERE slug = $1', [catSlug]);
  await query("DELETE FROM authors WHERE name LIKE 'Author ' || $1 || '%'", [tag]);
  await query("DELETE FROM users WHERE email LIKE 'cattest_%@example.com'");
  await server.close();
  await pool.end();
});

async function addBook(fields) {
  const res = await api('/api/admin/books', {
    method: 'POST',
    token: adminToken,
    body: { stock: 5, categorySlugs: [catSlug], ...fields },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  created.push(res.body.book.id);
  return res.body.book;
}

describe('admin book API', () => {
  test('requires login and admin role', async () => {
    const body = { title: 'Nope', pricePaise: 100 };
    assert.equal((await api('/api/admin/books', { method: 'POST', body })).status, 401);
    assert.equal(
      (await api('/api/admin/books', { method: 'POST', body, token: customerToken })).status,
      403,
    );
  });

  test('creates books with author, categories and a unique slug', async () => {
    const a = await addBook({
      title: `Alpha ${tag}`,
      authorName: `Author ${tag} One`,
      pricePaise: 30000,
      mrpPaise: 40000,
      language: 'English',
    });
    assert.equal(a.slug, `alpha-${tag}`);
    assert.equal(a.author.name, `Author ${tag} One`);
    assert.deepEqual(a.categories.map((c) => c.slug), [catSlug]);
    assert.equal(a.isActive, true);

    const again = await addBook({ title: `Alpha ${tag}`, pricePaise: 100 });
    assert.equal(again.slug, `alpha-${tag}-2`);

    await addBook({ title: `Beta ${tag}`, authorName: `Author ${tag} One`, pricePaise: 10000 });
    await addBook({ title: `Gamma ${tag}`, authorName: `Author ${tag} Two`, pricePaise: 50000 });
    const hidden = await addBook({ title: `Hidden ${tag}`, pricePaise: 20000, isActive: false });
    assert.equal(hidden.isActive, false);
  });

  test('validates input', async () => {
    const bad = await api('/api/admin/books', {
      method: 'POST',
      token: adminToken,
      body: { title: '', pricePaise: 12.5 },
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.length >= 2);

    const mrp = await api('/api/admin/books', {
      method: 'POST',
      token: adminToken,
      body: { title: 'X', pricePaise: 500, mrpPaise: 100 },
    });
    assert.equal(mrp.status, 400);
    assert.match(mrp.body.error, /MRP/);

    const cat = await api('/api/admin/books', {
      method: 'POST',
      token: adminToken,
      body: { title: 'X', pricePaise: 500, categorySlugs: ['no-such-category'] },
    });
    assert.equal(cat.status, 400);
    assert.match(cat.body.error, /Unknown category/);
  });

  test('updates a book and keeps the slug in step with the title', async () => {
    const book = await addBook({ title: `Delta ${tag}`, pricePaise: 1000 });
    const res = await api(`/api/admin/books/${book.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { title: `Delta Prime ${tag}`, stock: 0, categorySlugs: [] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.book.slug, `delta-prime-${tag}`);
    assert.equal(res.body.book.stock, 0);
    assert.deepEqual(res.body.book.categories, []);

    const notFound = await api('/api/admin/books/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      token: adminToken,
      body: { stock: 1 },
    });
    assert.equal(notFound.status, 404);
  });

  test('deletes a book', async () => {
    const book = await addBook({ title: `Doomed ${tag}`, pricePaise: 1000 });
    const res = await api(`/api/admin/books/${book.id}`, { method: 'DELETE', token: adminToken });
    assert.equal(res.status, 204);
    const again = await api(`/api/admin/books/${book.id}`, { method: 'DELETE', token: adminToken });
    assert.equal(again.status, 404);
  });

  test('admin list includes inactive books', async () => {
    const res = await api(`/api/admin/books?q=hidden ${tag}`, { token: adminToken });
    assert.equal(res.body.total, 1);
  });
});

describe('public catalogue API', () => {
  test('lists active books in a category, newest first', async () => {
    const res = await api(`/api/books?category=${catSlug}`);
    assert.equal(res.status, 200);
    const titles = res.body.items.map((b) => b.title);
    assert.ok(!titles.includes(`Hidden ${tag}`), 'inactive book must not be listed');
    // Delta was taken out of the category by the update test; Gamma is the newest left.
    assert.equal(titles[0], `Gamma ${tag}`);
    assert.ok(!titles.includes(`Delta Prime ${tag}`));
    assert.equal(res.body.total, titles.length);
  });

  test('searches by title and by author name', async () => {
    const byTitle = await api(`/api/books?q=gamma ${tag}`);
    assert.deepEqual(byTitle.body.items.map((b) => b.title), [`Gamma ${tag}`]);

    const byAuthor = await api(`/api/books?q=${encodeURIComponent(`Author ${tag} One`)}`);
    assert.equal(byAuthor.body.total, 2);

    const wildcard = await api(`/api/books?q=${encodeURIComponent('%_%')}`);
    assert.equal(wildcard.body.total, 0, 'LIKE wildcards are escaped');
  });

  test('sorts by price and pages results', async () => {
    const asc = await api(`/api/books?category=${catSlug}&sort=price_asc`);
    const prices = asc.body.items.map((b) => b.pricePaise);
    assert.deepEqual(prices, [...prices].sort((x, y) => x - y));

    const page1 = await api(`/api/books?category=${catSlug}&sort=title&limit=2&page=1`);
    const page2 = await api(`/api/books?category=${catSlug}&sort=title&limit=2&page=2`);
    assert.equal(page1.body.items.length, 2);
    assert.equal(page1.body.totalPages, Math.ceil(page1.body.total / 2));
    assert.notEqual(page1.body.items[0].id, page2.body.items[0].id);
  });

  test('rejects bad query values', async () => {
    assert.equal((await api('/api/books?sort=random')).status, 400);
    assert.equal((await api('/api/books?limit=500')).status, 400);
  });

  test('gets one book by slug, but not an inactive one', async () => {
    const res = await api(`/api/books/gamma-${tag}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.book.author.name, `Author ${tag} Two`);
    assert.equal((await api(`/api/books/hidden-${tag}`)).status, 404);
  });

  test('lists categories with active book counts', async () => {
    const res = await api('/api/categories');
    const mine = res.body.items.find((c) => c.slug === catSlug);
    assert.ok(mine.bookCount >= 4);
  });
});

describe('home page lists', () => {
  test('featured filter, on-sale filter and discount sort', async () => {
    const featured = await addBook({ title: `Star ${tag}`, pricePaise: 10000, mrpPaise: 20000, isFeatured: true });
    assert.equal(featured.isFeatured, true);

    const list = await api(`/api/books?category=${catSlug}&featured=true`);
    assert.deepEqual(list.body.items.map((b) => b.title), [`Star ${tag}`]);

    const notFeatured = await api(`/api/books?category=${catSlug}&featured=false`);
    assert.ok(!notFeatured.body.items.some((b) => b.title === `Star ${tag}`));

    const offers = await api(`/api/books?category=${catSlug}&onSale=1&sort=discount`);
    assert.equal(offers.body.items[0].title, `Star ${tag}`, '50% off comes first');
    assert.ok(offers.body.items.every((b) => b.mrpPaise > b.pricePaise));

    assert.equal((await api('/api/books?featured=maybe')).status, 400);
  });

  test('best sellers are ordered by copies sold in completed orders', async () => {
    const a = await addBook({ title: `Seller A ${tag}`, pricePaise: 1000, stock: 50 });
    const b = await addBook({ title: `Seller B ${tag}`, pricePaise: 1000, stock: 50 });
    const { rows } = await query('SELECT id FROM users WHERE email LIKE $1 LIMIT 1', ['cattest_customer%']);
    const userId = rows[0].id;
    async function order(bookId, quantity, status) {
      const o = await query(
        `INSERT INTO orders (user_id, address_snapshot, total_paise, status) VALUES ($1, '{}', 0, $2) RETURNING id`,
        [userId, status],
      );
      await query(
        `INSERT INTO order_items (order_id, book_id, title_snapshot, unit_price_paise, quantity) VALUES ($1, $2, 'x', 0, $3)`,
        [o.rows[0].id, bookId, quantity],
      );
    }
    await order(a.id, 2, 'delivered');
    await order(b.id, 3, 'delivered');
    await order(a.id, 9, 'cancelled'); // does not count
    await order(a.id, 9, 'pending'); // unpaid: does not count

    const res = await api(`/api/books?category=${catSlug}&sort=bestselling`);
    const titles = res.body.items.map((x) => x.title);
    assert.ok(titles.indexOf(`Seller B ${tag}`) < titles.indexOf(`Seller A ${tag}`));
    assert.equal(titles.indexOf(`Seller B ${tag}`), 0);
    await query('DELETE FROM orders WHERE user_id = $1', [userId]);
  });
});

describe('cover uploads', () => {
  // 1x1 transparent PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );

  test('admin can upload a cover and it is served', async () => {
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'cover.png');
    const res = await api('/api/admin/uploads/cover', { method: 'POST', token: adminToken, form });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.url, /^\/uploads\/covers\/[0-9a-f-]+\.png$/);
    uploaded.push(res.body.url);

    const file = await fetch(`${server.base}${res.body.url}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
  });

  test('rejects non-images and non-admins', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    const bad = await api('/api/admin/uploads/cover', { method: 'POST', token: adminToken, form });
    assert.equal(bad.status, 400);

    const form2 = new FormData();
    form2.append('file', new Blob([png], { type: 'image/png' }), 'cover.png');
    const forbidden = await api('/api/admin/uploads/cover', {
      method: 'POST',
      token: customerToken,
      form: form2,
    });
    assert.equal(forbidden.status, 403);
  });

  test('missing upload files return 404 JSON', async () => {
    const res = await api('/uploads/covers/nope.png');
    assert.equal(res.status, 404);
  });
});
