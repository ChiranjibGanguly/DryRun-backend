// Order emails: confirmation (COD and online), shipped, cancelled.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db/pool.js';
import { razorpay, signForTest } from '../src/services/razorpay.js';
import { createUser, signToken } from '../src/services/userService.js';
import { makeApi, makeUserToken, outbox, startServer, waitForEmail } from './helpers.js';

const tag = `em${Date.now().toString(36)}`;
let server;
let api;
let admin;
let customer;
let email;
let bookId;

before(async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
  process.env.RAZORPAY_KEY_SECRET = 'secret_for_emails';
  razorpay.createOrder = async () => `order_em_${Date.now()}`;
  server = await startServer();
  api = makeApi(server.base);
  admin = await makeUserToken('emtest_admin', 'admin');
  email = `emtest_cust_${tag}@example.com`;
  const user = await createUser({ name: 'Meera Rao', email, password: 'secret123' });
  customer = signToken(user);
  const { rows } = await query(
    `INSERT INTO books (title, slug, price_paise, stock) VALUES ($1, $2, 25000, 50) RETURNING id`,
    [`Email Book ${tag}`, `email-book-${tag}`],
  );
  bookId = rows[0].id;
  await api('/api/addresses', {
    method: 'POST', token: customer,
    body: { name: 'Meera Rao', phone: '9988776655', line1: '7 Brigade Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
  });
});

after(async () => {
  await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'emtest_%@example.com')`);
  await query("DELETE FROM users WHERE email LIKE 'emtest_%@example.com'");
  await query('DELETE FROM books WHERE id = $1', [bookId]);
  await server.close();
  await pool.end();
});

async function place(paymentMethod) {
  await api('/api/cart/items', { method: 'POST', token: customer, body: { bookId, quantity: 2 } });
  const addressId = (await api('/api/addresses', { token: customer })).body.items[0].id;
  const res = await api('/api/orders', { method: 'POST', token: customer, body: { addressId, paymentMethod } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const refOf = (id) => `#${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

test('COD order sends a confirmation with items, total and address', async () => {
  const { order } = await place('cod');
  const mail = await waitForEmail((m) => m.subject === `Order ${refOf(order.id)} confirmed`);
  assert.equal(mail.to, email);
  assert.match(mail.text, /Hi Meera Rao/);
  assert.match(mail.text, /2 × Email Book/);
  assert.match(mail.text, /Total – ₹500/);
  assert.match(mail.text, /cash on delivery/);
  assert.match(mail.text, /Bengaluru, Karnataka 560001/);
  assert.match(mail.html, /View your order/);
  assert.match(mail.text, new RegExp(`/orders/${order.id}`));
});

test('online order: no email until paid, then exactly one confirmation', async () => {
  const { order, payment } = await place('online');
  const subject = `Order ${refOf(order.id)} confirmed`;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(outbox.filter((m) => m.subject === subject).length, 0, 'pending order: no email yet');

  const body = {
    orderId: order.id,
    razorpayOrderId: payment.razorpayOrderId,
    razorpayPaymentId: 'pay_em_1',
    razorpaySignature: signForTest('secret_for_emails', `${payment.razorpayOrderId}|pay_em_1`),
  };
  await api('/api/payments/verify', { method: 'POST', token: customer, body });
  await api('/api/payments/verify', { method: 'POST', token: customer, body }); // repeated
  const mail = await waitForEmail((m) => m.subject === subject);
  assert.match(mail.text, /received your payment of ₹500/);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(outbox.filter((m) => m.subject === subject).length, 1, 'only one confirmation');
});

test('shipping sends tracking details', async () => {
  const { order } = await place('cod');
  await api(`/api/admin/orders/${order.id}/status`, {
    method: 'PATCH', token: admin, body: { status: 'shipped', courier: 'Delhivery', trackingNumber: 'DL12345' },
  });
  const mail = await waitForEmail((m) => m.subject === `Order ${refOf(order.id)} is on its way`);
  assert.match(mail.text, /Tracking: Delhivery – DL12345/);
  assert.match(mail.text, /keep ₹500 ready/);
});

test('cancelling sends a cancellation email', async () => {
  const { order } = await place('cod');
  await api(`/api/orders/${order.id}/cancel`, { method: 'POST', token: customer });
  const mail = await waitForEmail((m) => m.subject === `Order ${refOf(order.id)} cancelled`);
  assert.match(mail.text, /As you asked/);

  const second = (await place('cod')).order;
  await api(`/api/admin/orders/${second.id}/status`, { method: 'PATCH', token: admin, body: { status: 'cancelled' } });
  const byShop = await waitForEmail((m) => m.subject === `Order ${refOf(second.id)} cancelled`);
  assert.match(byShop.text, /We had to cancel/);
});

test('an email failure does not break ordering', async () => {
  const { mailer } = await import('../src/services/mailer.js');
  const saved = mailer.transport;
  mailer.transport = async () => {
    throw new Error('mail server down');
  };
  try {
    const { order } = await place('cod');
    assert.equal(order.status, 'placed');
  } finally {
    await new Promise((r) => setTimeout(r, 100));
    mailer.transport = saved;
  }
});
