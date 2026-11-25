// Integration tests for admin orders, dashboard stats and CSV import.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db/pool.js';
import { makeApi, makeUserToken, startServer } from './helpers.js';

const tag = `ad${Date.now().toString(36)}`;
let server;
let api;
let admin;
let customer;
let bookId;

const address = {
  name: 'Ravi Kumar', phone: '9123456780', line1: '4 Lake Road',
  city: 'Pune', state: 'Maharashtra', pincode: '411001',
};

async function placeCodOrder(qty = 1) {
  await api('/api/cart/items', { method: 'POST', token: customer, body: { bookId, quantity: qty } });
  let list = (await api('/api/addresses', { token: customer })).body.items;
  if (!list.length) {
    await api('/api/addresses', { method: 'POST', token: customer, body: address });
    list = (await api('/api/addresses', { token: customer })).body.items;
  }
  const res = await api('/api/orders', {
    method: 'POST', token: customer, body: { addressId: list[0].id, paymentMethod: 'cod' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.order;
}
const stockOf = async () => (await query('SELECT stock FROM books WHERE id = $1', [bookId])).rows[0].stock;

before(async () => {
  server = await startServer();
  api = makeApi(server.base);
  admin = await makeUserToken('adtest_admin', 'admin');
  customer = await makeUserToken('adtest_cust');
  const { rows } = await query(
    `INSERT INTO books (title, slug, price_paise, stock) VALUES ($1, $2, 30000, 10) RETURNING id`,
    [`Admin Book ${tag}`, `admin-book-${tag}`],
  );
  bookId = rows[0].id;
});

after(async () => {
  await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'adtest_%@example.com')`);
  await query("DELETE FROM users WHERE email LIKE 'adtest_%@example.com'");
  await query("DELETE FROM books WHERE id = $1 OR title LIKE '%' || $2 || '%'", [bookId, tag]);
  await query("DELETE FROM authors WHERE name LIKE '%' || $1 || '%'", [tag]);
  await server.close();
  await pool.end();
});

describe('admin access', () => {
  test('customers cannot use admin endpoints', async () => {
    for (const path of ['/api/admin/stats', '/api/admin/orders', '/api/admin/books/import/template']) {
      assert.equal((await api(path, { token: customer })).status, 403, path);
      assert.equal((await api(path)).status, 401, path);
    }
  });
});

describe('admin orders', () => {
  test('lists orders with customer details and filters', async () => {
    const order = await placeCodOrder();
    const res = await api('/api/admin/orders?status=to_ship', { token: admin });
    const found = res.body.items.find((o) => o.id === order.id);
    assert.ok(found, 'new COD order is in "to ship"');
    assert.match(found.customer.email, /^adtest_cust/);

    const byRef = await api(`/api/admin/orders?q=%23${order.id.replace(/-/g, '').slice(0, 8)}`, { token: admin });
    assert.equal(byRef.body.items[0].id, order.id);

    const byEmail = await api(`/api/admin/orders?q=adtest_cust`, { token: admin });
    assert.ok(byEmail.body.items.some((o) => o.id === order.id));
  });

  test('ships, then delivers; delivering a COD order marks it paid', async () => {
    const order = await placeCodOrder();
    const early = await api(`/api/admin/orders/${order.id}/status`, {
      method: 'PATCH', token: admin, body: { status: 'delivered' },
    });
    assert.equal(early.status, 409, 'cannot deliver before shipping');

    const shipped = await api(`/api/admin/orders/${order.id}/status`, {
      method: 'PATCH', token: admin, body: { status: 'shipped', courier: 'India Post', trackingNumber: 'EE123456789IN' },
    });
    assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
    assert.equal(shipped.body.order.status, 'shipped');
    assert.equal(shipped.body.order.trackingNumber, 'EE123456789IN');
    assert.ok(shipped.body.order.shippedAt);

    const cancel = await api(`/api/admin/orders/${order.id}/status`, {
      method: 'PATCH', token: admin, body: { status: 'cancelled' },
    });
    assert.equal(cancel.status, 409, 'shipped orders cannot be cancelled');

    const delivered = await api(`/api/admin/orders/${order.id}/status`, {
      method: 'PATCH', token: admin, body: { status: 'delivered' },
    });
    assert.equal(delivered.body.order.status, 'delivered');
    assert.equal(delivered.body.order.paymentStatus, 'paid');
    assert.ok(delivered.body.order.deliveredAt);

    const mine = await api(`/api/orders/${order.id}`, { token: customer });
    assert.equal(mine.body.order.status, 'delivered', 'customer sees the new status');
  });

  test('admin cancel returns stock', async () => {
    const order = await placeCodOrder(2);
    const before = await stockOf();
    const res = await api(`/api/admin/orders/${order.id}/status`, {
      method: 'PATCH', token: admin, body: { status: 'cancelled' },
    });
    assert.equal(res.body.order.status, 'cancelled');
    assert.equal(await stockOf(), before + 2);
  });

  test('mark a COD order paid', async () => {
    const order = await placeCodOrder();
    const res = await api(`/api/admin/orders/${order.id}/mark-paid`, { method: 'POST', token: admin });
    assert.equal(res.body.order.paymentStatus, 'paid');
    assert.ok(res.body.order.paidAt);
    assert.equal(res.body.order.status, 'placed', 'still needs shipping');
  });

  test('unknown order and bad status', async () => {
    const missing = await api('/api/admin/orders/00000000-0000-0000-0000-000000000000', { token: admin });
    assert.equal(missing.status, 404);
    const order = await placeCodOrder();
    const bad = await api(`/api/admin/orders/${order.id}/status`, {
      method: 'PATCH', token: admin, body: { status: 'paid' },
    });
    assert.equal(bad.status, 400);
  });
});

describe('dashboard stats', () => {
  test('reports orders, sales and low stock', async () => {
    await query('UPDATE books SET stock = 2 WHERE id = $1', [bookId]);
    const res = await api('/api/admin/stats', { token: admin });
    assert.equal(res.status, 200);
    for (const key of ['ordersToday', 'salesTodayPaise', 'sales30dPaise', 'toShip', 'shipped',
      'awaitingPayment', 'activeBooks', 'outOfStock']) {
      assert.equal(typeof res.body[key], 'number', key);
    }
    assert.ok(res.body.ordersToday >= 1);
    assert.ok(res.body.lowStock.some((b) => b.id === bookId));
    await query('UPDATE books SET stock = 10 WHERE id = $1', [bookId]);
  });
});

describe('CSV import', () => {
  const upload = (csv, dryRun = false) => {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'books.csv');
    return api(`/api/admin/books/import${dryRun ? '?dryRun=1' : ''}`, { method: 'POST', token: admin, form });
  };
  const isbnA = `978${Date.now().toString().slice(-10)}`;

  const csv =
    'Title,Author,Price,MRP,Stock,ISBN,Language,Categories,Description,Active\n' +
    `Import One ${tag},Author ${tag},"₹1,299.50",1499,7,${isbnA},English,Fiction;children,"Has, a comma",yes\n` +
    `Import Two ${tag},Author ${tag},199,,3,,Hindi,non-fiction,,no\n` +
    `,Nobody,abc,,x,123,,mystery,,\n`;

  test('dry run checks every row and writes nothing', async () => {
    const res = await upload(csv, true);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.created, 2);
    assert.equal(res.body.failed, 1);
    const bad = res.body.rows.find((r) => r.action === 'error');
    assert.equal(bad.row, 4);
    assert.ok(bad.errors.some((e) => /title is required/.test(e)));
    assert.ok(bad.errors.some((e) => /price "abc"/.test(e)));
    assert.ok(bad.errors.some((e) => /unknown category "mystery"/.test(e)));
    const { rows } = await query('SELECT 1 FROM books WHERE title LIKE $1', [`Import %${tag}%`]);
    assert.equal(rows.length, 0);
  });

  test('import creates books, then updates by ISBN', async () => {
    const res = await upload(csv);
    assert.equal(res.body.created, 2);
    assert.equal(res.body.failed, 1);

    const one = (await query(
      `SELECT b.price_paise, b.mrp_paise, b.stock, b.is_active, b.description, a.name AS author,
              array(SELECT c.slug FROM book_categories bc JOIN categories c ON c.id = bc.category_id
                    WHERE bc.book_id = b.id ORDER BY c.slug) AS cats
       FROM books b LEFT JOIN authors a ON a.id = b.author_id WHERE b.isbn = $1`, [isbnA])).rows[0];
    assert.equal(one.price_paise, 129950);
    assert.equal(one.mrp_paise, 149900);
    assert.equal(one.stock, 7);
    assert.equal(one.description, 'Has, a comma');
    assert.equal(one.author, `Author ${tag}`);
    assert.deepEqual(one.cats, ['children', 'fiction']);

    const two = (await query('SELECT is_active FROM books WHERE title = $1', [`Import Two ${tag}`])).rows[0];
    assert.equal(two.is_active, false);

    const again = await upload(
      'title,price,stock,isbn\n' + `Import One ${tag} (2nd ed),999,20,${isbnA}\n`,
    );
    assert.equal(again.body.updated, 1);
    assert.equal(again.body.created, 0);
    const updated = (await query('SELECT title, price_paise, stock FROM books WHERE isbn = $1', [isbnA])).rows[0];
    assert.deepEqual(updated, { title: `Import One ${tag} (2nd ed)`, price_paise: 99900, stock: 20 });
  });

  test('rejects files without the required columns', async () => {
    const res = await upload('name,cost\nA,1\n');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /title and price are required/);
  });

  test('template downloads as CSV', async () => {
    const res = await api('/api/admin/books/import/template', { token: admin });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.body, /^title,author,price,mrp,stock,isbn/);
  });
});
