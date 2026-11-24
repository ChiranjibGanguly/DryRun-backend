// Integration tests for cart, addresses, orders and payments.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db/pool.js';
import { razorpay, signForTest } from '../src/services/razorpay.js';
import { makeApi, makeUserToken, startServer } from './helpers.js';

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';
const tag = `ck${Date.now().toString(36)}`;

let server;
let api;
let token;
let otherToken;
let cheap; // ₹100, stock 5
let pricey; // ₹600, stock 2
const realCreateOrder = razorpay.createOrder;
let rzpCalls = [];

async function insertBook(title, pricePaise, stock) {
  const { rows } = await query(
    `INSERT INTO books (title, slug, price_paise, stock) VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, `${title.toLowerCase().replace(/\s+/g, '-')}`, pricePaise, stock],
  );
  return rows[0].id;
}
const stockOf = async (id) => (await query('SELECT stock FROM books WHERE id = $1', [id])).rows[0].stock;

const validAddress = {
  name: 'Asha Reader',
  phone: '+91 98765 43210',
  line1: '12 MG Road',
  city: 'Kolkata',
  state: 'West Bengal',
  pincode: '700001',
};

before(async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  server = await startServer();
  api = makeApi(server.base);
  token = await makeUserToken('cktest_a');
  otherToken = await makeUserToken('cktest_b');
  cheap = await insertBook(`Cheap ${tag}`, 10000, 5);
  pricey = await insertBook(`Pricey ${tag}`, 60000, 2);
});

beforeEach(async () => {
  rzpCalls = [];
  razorpay.createOrder = async (args) => {
    rzpCalls.push(args);
    return `order_test_${rzpCalls.length}_${Date.now()}`;
  };
  await query('UPDATE books SET stock = 5 WHERE id = $1', [cheap]);
  await query('UPDATE books SET stock = 2 WHERE id = $1', [pricey]);
  await query(
    `DELETE FROM cart_items WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'cktest_%@example.com')`,
  );
});

after(async () => {
  razorpay.createOrder = realCreateOrder;
  await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'cktest_%@example.com')`);
  await query("DELETE FROM users WHERE email LIKE 'cktest_%@example.com'");
  await query('DELETE FROM books WHERE id = ANY($1)', [[cheap, pricey]]);
  await server.close();
  await pool.end();
});

describe('cart', () => {
  test('needs login', async () => {
    assert.equal((await api('/api/cart')).status, 401);
  });

  test('adds, increments, updates and removes items with totals', async () => {
    let res = await api('/api/cart/items', { method: 'POST', token, body: { bookId: cheap } });
    assert.equal(res.status, 201);
    res = await api('/api/cart/items', { method: 'POST', token, body: { bookId: cheap, quantity: 2 } });
    assert.equal(res.body.items[0].quantity, 3);
    assert.equal(res.body.subtotalPaise, 30000);
    assert.equal(res.body.shippingPaise, 4900, 'flat shipping below ₹499');
    assert.equal(res.body.totalPaise, 34900);
    assert.equal(res.body.itemCount, 3);

    res = await api(`/api/cart/items/${pricey}`, { method: 'PATCH', token, body: { quantity: 1 } });
    assert.equal(res.status, 404, 'cannot set quantity of a book not in the cart');

    res = await api('/api/cart/items', { method: 'POST', token, body: { bookId: pricey } });
    assert.equal(res.body.subtotalPaise, 90000);
    assert.equal(res.body.shippingPaise, 0, 'free shipping from ₹499');

    res = await api(`/api/cart/items/${cheap}`, { method: 'PATCH', token, body: { quantity: 1 } });
    assert.equal(res.body.items.find((i) => i.book.id === cheap).quantity, 1);

    res = await api(`/api/cart/items/${cheap}`, { method: 'DELETE', token });
    assert.deepEqual(res.body.items.map((i) => i.book.id), [pricey]);
    assert.equal(res.body.canCheckout, true);
  });

  test('cannot add more than the stock', async () => {
    const res = await api('/api/cart/items', { method: 'POST', token, body: { bookId: pricey, quantity: 3 } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Only 2 in stock/);
  });

  test('flags cart lines that lost their stock', async () => {
    await api('/api/cart/items', { method: 'POST', token, body: { bookId: pricey, quantity: 2 } });
    await query('UPDATE books SET stock = 1 WHERE id = $1', [pricey]);
    const res = await api('/api/cart', { token });
    assert.equal(res.body.items[0].issue, 'not_enough_stock');
    assert.equal(res.body.canCheckout, false);
    await query('UPDATE books SET stock = 2 WHERE id = $1', [pricey]);
  });
});

describe('addresses', () => {
  let first;

  test('validates Indian phone and PIN code', async () => {
    const res = await api('/api/addresses', {
      method: 'POST',
      token,
      body: { ...validAddress, phone: '12345', pincode: '0123' },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.details.map((d) => d.field).sort(), ['phone', 'pincode']);
  });

  test('first address becomes default; a new default replaces it', async () => {
    let res = await api('/api/addresses', { method: 'POST', token, body: validAddress });
    assert.equal(res.status, 201);
    first = res.body.address;
    assert.equal(first.isDefault, true);
    assert.equal(first.phone, '9876543210', 'phone is normalised');

    res = await api('/api/addresses', {
      method: 'POST',
      token,
      body: { ...validAddress, line1: '5 Park Street', isDefault: true },
    });
    const second = res.body.address;
    const list = (await api('/api/addresses', { token })).body.items;
    assert.equal(list[0].id, second.id);
    assert.equal(list.filter((a) => a.isDefault).length, 1);

    await api(`/api/addresses/${second.id}`, { method: 'DELETE', token });
    const after = (await api('/api/addresses', { token })).body.items;
    assert.equal(after.length, 1);
    assert.equal(after[0].isDefault, true, 'remaining address becomes default');
  });

  test("other users cannot see or change someone's address", async () => {
    const res = await api(`/api/addresses/${first.id}`, {
      method: 'PATCH',
      token: otherToken,
      body: { city: 'Delhi' },
    });
    assert.equal(res.status, 404);
  });
});

async function addressId(t = token) {
  const list = (await api('/api/addresses', { token: t })).body.items;
  if (list.length) return list[0].id;
  return (await api('/api/addresses', { method: 'POST', token: t, body: validAddress })).body.address.id;
}

describe('cash on delivery orders', () => {
  test('places an order, reserves stock and empties the cart', async () => {
    await api('/api/cart/items', { method: 'POST', token, body: { bookId: cheap, quantity: 2 } });
    const before = await stockOf(cheap);

    const res = await api('/api/orders', {
      method: 'POST',
      token,
      body: { addressId: await addressId(), paymentMethod: 'cod' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { order, payment } = res.body;
    assert.equal(payment, null);
    assert.equal(order.status, 'placed');
    assert.equal(order.paymentMethod, 'cod');
    assert.equal(order.paymentStatus, 'unpaid');
    assert.equal(order.subtotalPaise, 20000);
    assert.equal(order.shippingPaise, 4900);
    assert.equal(order.totalPaise, 24900);
    assert.equal(order.items[0].quantity, 2);
    assert.equal(order.address.city, 'Kolkata');
    assert.equal(rzpCalls.length, 0);

    assert.equal(await stockOf(cheap), before - 2);
    assert.equal((await api('/api/cart', { token })).body.items.length, 0);

    const list = await api('/api/orders', { token });
    assert.equal(list.body.items[0].id, order.id);
    assert.equal((await api(`/api/orders/${order.id}`, { token: otherToken })).status, 404);
  });

  test('cancelling puts the stock back', async () => {
    await api('/api/cart/items', { method: 'POST', token, body: { bookId: cheap } });
    const placed = await api('/api/orders', {
      method: 'POST',
      token,
      body: { addressId: await addressId(), paymentMethod: 'cod' },
    });
    const before = await stockOf(cheap);
    const res = await api(`/api/orders/${placed.body.order.id}/cancel`, { method: 'POST', token });
    assert.equal(res.body.order.status, 'cancelled');
    assert.equal(await stockOf(cheap), before + 1);

    const again = await api(`/api/orders/${placed.body.order.id}/cancel`, { method: 'POST', token });
    assert.equal(again.status, 409);
  });

  test('refuses an empty cart and a missing address', async () => {
    const empty = await api('/api/orders', {
      method: 'POST',
      token,
      body: { addressId: await addressId(), paymentMethod: 'cod' },
    });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /cart is empty/);

    await api('/api/cart/items', { method: 'POST', token, body: { bookId: cheap } });
    const noAddr = await api('/api/orders', {
      method: 'POST',
      token,
      body: { addressId: await addressId(otherToken), paymentMethod: 'cod' },
    });
    assert.equal(noAddr.status, 404, "cannot use another user's address");
  });

  test('two shoppers cannot both buy the last copy', async () => {
    await query('UPDATE books SET stock = 1 WHERE id = $1', [pricey]);
    await api('/api/cart/items', { method: 'POST', token, body: { bookId: pricey } });
    await api('/api/cart/items', { method: 'POST', token: otherToken, body: { bookId: pricey } });

    const [a, b] = await Promise.all([
      api('/api/orders', { method: 'POST', token, body: { addressId: await addressId(), paymentMethod: 'cod' } }),
      api('/api/orders', {
        method: 'POST',
        token: otherToken,
        body: { addressId: await addressId(otherToken), paymentMethod: 'cod' },
      }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(await stockOf(pricey), 0);
    await query('UPDATE books SET stock = 2 WHERE id = $1', [pricey]);
  });
});

describe('online payment (Razorpay)', () => {
  async function placeOnline() {
    await api('/api/cart/items', { method: 'POST', token, body: { bookId: pricey } });
    const res = await api('/api/orders', {
      method: 'POST',
      token,
      body: { addressId: await addressId(), paymentMethod: 'online' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  test('payment config reports online payment as enabled', async () => {
    const res = await api('/api/payments/config');
    assert.deepEqual(res.body, { online: true, cod: true, razorpayKeyId: 'rzp_test_dummy' });
  });

  test('creates a pending order with Razorpay details', async () => {
    const { order, payment } = await placeOnline();
    assert.equal(order.status, 'pending');
    assert.equal(rzpCalls[0].amountPaise, 60000);
    assert.equal(rzpCalls[0].receipt, order.id);
    assert.equal(payment.keyId, 'rzp_test_dummy');
    assert.equal(payment.amountPaise, 60000);
    assert.match(payment.razorpayOrderId, /^order_test_/);
    assert.equal(payment.prefill.contact, '9876543210');
  });

  test('verifies a correct signature and rejects a wrong one', async () => {
    const { order, payment } = await placeOnline();
    const body = {
      orderId: order.id,
      razorpayOrderId: payment.razorpayOrderId,
      razorpayPaymentId: 'pay_test_1',
      razorpaySignature: 'not-the-right-signature',
    };
    const bad = await api('/api/payments/verify', { method: 'POST', token, body });
    assert.equal(bad.status, 400);

    body.razorpaySignature = signForTest(KEY_SECRET, `${payment.razorpayOrderId}|pay_test_1`);
    const good = await api('/api/payments/verify', { method: 'POST', token, body });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.order.status, 'paid');
    assert.equal(good.body.order.paymentStatus, 'paid');
    assert.ok(good.body.order.paidAt);

    const again = await api('/api/payments/verify', { method: 'POST', token, body });
    assert.equal(again.status, 200, 'verifying twice is harmless');

    const cancel = await api(`/api/orders/${order.id}/cancel`, { method: 'POST', token });
    assert.equal(cancel.status, 409, 'paid orders are not cancelled here');
  });

  test('a closed payment popup can be retried', async () => {
    const { order, payment } = await placeOnline();
    const retry = await api(`/api/orders/${order.id}/payment`, { method: 'POST', token });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.payment.razorpayOrderId, payment.razorpayOrderId);
    await api(`/api/orders/${order.id}/cancel`, { method: 'POST', token });
  });

  test('webhook marks the order paid when the signature is right', async () => {
    const { order, payment } = await placeOnline();
    const event = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_hook_1', order_id: payment.razorpayOrderId } } },
    });
    const send = (signature) =>
      fetch(`${server.base}/api/payments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature },
        body: event,
      });

    assert.equal((await send('wrong')).status, 400);
    const ok = await send(signForTest(WEBHOOK_SECRET, event));
    assert.equal(ok.status, 200);

    const res = await api(`/api/orders/${order.id}`, { token });
    assert.equal(res.body.order.status, 'paid');
  });

  test('if Razorpay fails, the order is undone and the cart restored', async () => {
    razorpay.createOrder = async () => {
      throw new Error('down');
    };
    await api('/api/cart/items', { method: 'POST', token, body: { bookId: cheap, quantity: 2 } });
    const before = await stockOf(cheap);
    const res = await api('/api/orders', {
      method: 'POST',
      token,
      body: { addressId: await addressId(), paymentMethod: 'online' },
    });
    assert.equal(res.status, 502);
    assert.equal(await stockOf(cheap), before);
    const cart = await api('/api/cart', { token });
    assert.equal(cart.body.items[0].quantity, 2);
  });

  test('online payment is refused when keys are not set', async () => {
    const saved = process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      await api('/api/cart/items', { method: 'POST', token, body: { bookId: cheap } });
      const res = await api('/api/orders', {
        method: 'POST',
        token,
        body: { addressId: await addressId(), paymentMethod: 'online' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /cash on delivery/);
      assert.equal((await api('/api/payments/config')).body.online, false);
    } finally {
      process.env.RAZORPAY_KEY_SECRET = saved;
    }
  });
});
