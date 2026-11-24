import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';
import { getAddress } from './addressService.js';
import { shippingFor } from './cartService.js';
import { isValidPaymentSignature, razorpay } from './razorpay.js';

const ORDER_SELECT = `
  SELECT o.*,
    COALESCE(json_agg(json_build_object(
      'bookId', oi.book_id, 'slug', b.slug, 'title', oi.title_snapshot,
      'coverUrl', b.cover_url, 'unitPricePaise', oi.unit_price_paise,
      'quantity', oi.quantity, 'lineTotalPaise', oi.unit_price_paise * oi.quantity
    ) ORDER BY oi.title_snapshot) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
  FROM orders o
  LEFT JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN books b ON b.id = oi.book_id`;

export function toOrder(r) {
  return {
    id: r.id,
    status: r.status,
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    subtotalPaise: r.subtotal_paise,
    shippingPaise: r.shipping_paise,
    totalPaise: r.total_paise,
    address: r.address_snapshot,
    items: r.items ?? [],
    createdAt: r.created_at,
    paidAt: r.paid_at,
    cancelledAt: r.cancelled_at,
  };
}

async function findOrder(where, params) {
  const { rows } = await query(`${ORDER_SELECT} WHERE ${where} GROUP BY o.id`, params);
  return rows[0] ? { row: rows[0], order: toOrder(rows[0]) } : null;
}

export async function getOrder(userId, id) {
  const found = await findOrder('o.id = $1 AND o.user_id = $2', [id, userId]);
  if (!found) throw new HttpError(404, 'Order not found');
  return found.order;
}

export async function listOrders(userId, { page = 1, limit = 10 } = {}) {
  const { rows: countRows } = await query('SELECT count(*)::int AS total FROM orders WHERE user_id = $1', [userId]);
  const { rows } = await query(
    `${ORDER_SELECT} WHERE o.user_id = $1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, (page - 1) * limit],
  );
  const total = countRows[0].total;
  return { items: rows.map(toOrder), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function paymentDetails(userId, orderRow) {
  const { rows } = await query('SELECT name, email, phone FROM users WHERE id = $1', [userId]);
  const user = rows[0] ?? {};
  return {
    provider: 'razorpay',
    keyId: config.razorpayKeyId,
    razorpayOrderId: orderRow.razorpay_order_id,
    amountPaise: orderRow.total_paise,
    currency: 'INR',
    prefill: {
      name: orderRow.address_snapshot?.name || user.name,
      email: user.email,
      contact: orderRow.address_snapshot?.phone || user.phone || undefined,
    },
  };
}

/** Puts back stock (and optionally the cart) for an order being cancelled. */
async function releaseOrder(client, orderId, userId, { restoreCart }) {
  const { rows: items } = await client.query(
    'SELECT book_id, quantity FROM order_items WHERE order_id = $1 AND book_id IS NOT NULL',
    [orderId],
  );
  for (const it of items) {
    await client.query('UPDATE books SET stock = stock + $2 WHERE id = $1', [it.book_id, it.quantity]);
    if (restoreCart) {
      await client.query(
        `INSERT INTO cart_items (user_id, book_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, book_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [userId, it.book_id, it.quantity],
      );
    }
  }
  await client.query(
    `UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
    [orderId],
  );
}

/**
 * Turns the user's cart into an order. Stock is reserved straight away.
 * Cash on delivery -> status "placed". Online -> status "pending" plus a
 * Razorpay order the app opens checkout with.
 */
export async function placeOrder(userId, { addressId, paymentMethod }) {
  if (paymentMethod === 'online' && !config.onlinePaymentsEnabled) {
    throw new HttpError(400, 'Online payment is not set up yet. Please choose cash on delivery.');
  }
  const address = await getAddress(userId, addressId);

  const orderId = await inTransaction(async (client) => {
    // Lock the books in a fixed order so two checkouts cannot oversell.
    const { rows: lines } = await client.query(
      `SELECT ci.quantity, b.id AS book_id, b.title, b.price_paise, b.stock, b.is_active
       FROM cart_items ci JOIN books b ON b.id = ci.book_id
       WHERE ci.user_id = $1
       ORDER BY b.id
       FOR UPDATE OF b`,
      [userId],
    );
    if (!lines.length) throw new HttpError(400, 'Your cart is empty');

    const problems = lines.filter((l) => !l.is_active || l.stock < l.quantity);
    if (problems.length) {
      throw new HttpError(
        409,
        `Not enough stock for: ${problems.map((p) => p.title).join(', ')}. Please update your cart.`,
      );
    }

    const subtotal = lines.reduce((s, l) => s + l.price_paise * l.quantity, 0);
    const shipping = shippingFor(subtotal);
    const { rows } = await client.query(
      `INSERT INTO orders (user_id, address_snapshot, subtotal_paise, shipping_paise, total_paise,
                           status, payment_method, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'unpaid')
       RETURNING id`,
      [
        userId,
        JSON.stringify(address),
        subtotal,
        shipping,
        subtotal + shipping,
        paymentMethod === 'cod' ? 'placed' : 'pending',
        paymentMethod,
      ],
    );
    const id = rows[0].id;

    for (const l of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, book_id, title_snapshot, unit_price_paise, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, l.book_id, l.title, l.price_paise, l.quantity],
      );
      await client.query('UPDATE books SET stock = stock - $2 WHERE id = $1', [l.book_id, l.quantity]);
    }
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
    return id;
  });

  if (paymentMethod === 'cod') {
    return { order: await getOrder(userId, orderId), payment: null };
  }

  // Online: create the Razorpay order. If that fails, undo everything.
  let razorpayOrderId;
  try {
    const { rows } = await query('SELECT total_paise FROM orders WHERE id = $1', [orderId]);
    razorpayOrderId = await razorpay.createOrder({
      amountPaise: rows[0].total_paise,
      receipt: orderId,
      notes: { orderId },
    });
  } catch (err) {
    await inTransaction((client) => releaseOrder(client, orderId, userId, { restoreCart: true }));
    throw new HttpError(
      502,
      'Online payment is not available right now. Your cart is unchanged; try again or choose cash on delivery.',
    );
  }
  await query('UPDATE orders SET razorpay_order_id = $2 WHERE id = $1', [orderId, razorpayOrderId]);
  const found = await findOrder('o.id = $1', [orderId]);
  return { order: found.order, payment: await paymentDetails(userId, found.row) };
}

/** Payment details again for a pending online order (e.g. the popup was closed). */
export async function retryPayment(userId, orderId) {
  const found = await findOrder('o.id = $1 AND o.user_id = $2', [orderId, userId]);
  if (!found) throw new HttpError(404, 'Order not found');
  const { row } = found;
  if (row.payment_method !== 'online' || row.status !== 'pending' || !row.razorpay_order_id) {
    throw new HttpError(409, 'This order is not waiting for payment');
  }
  if (!config.onlinePaymentsEnabled) throw new HttpError(400, 'Online payment is not set up yet');
  return { order: found.order, payment: await paymentDetails(userId, row) };
}

/** Called by the app after Razorpay checkout succeeds. */
export async function confirmPayment(userId, { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const found = await findOrder('o.id = $1 AND o.user_id = $2', [orderId, userId]);
  if (!found) throw new HttpError(404, 'Order not found');
  const { row } = found;

  if (row.razorpay_order_id !== razorpayOrderId ||
      !isValidPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature: razorpaySignature })) {
    throw new HttpError(400, 'Payment could not be verified');
  }
  if (row.status === 'paid') return found.order; // already confirmed (e.g. by webhook)
  if (row.status !== 'pending') {
    throw new HttpError(409, 'This order was cancelled. Please contact support about a refund.');
  }

  await query(
    `UPDATE orders SET status = 'paid', payment_status = 'paid', payment_id = $2, paid_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [orderId, razorpayPaymentId],
  );
  return getOrder(userId, orderId);
}

/** Webhook: marks the order with this Razorpay order id as paid. Returns true if it changed. */
export async function markPaidFromWebhook(razorpayOrderId, paymentId) {
  const { rowCount } = await query(
    `UPDATE orders SET status = 'paid', payment_status = 'paid',
                       payment_id = COALESCE(payment_id, $2), paid_at = COALESCE(paid_at, now())
     WHERE razorpay_order_id = $1 AND status = 'pending'`,
    [razorpayOrderId, paymentId],
  );
  return rowCount > 0;
}

/** Customers can cancel unpaid orders; stock is put back. */
export async function cancelOrder(userId, orderId) {
  await inTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT status FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [orderId, userId],
    );
    if (!rows[0]) throw new HttpError(404, 'Order not found');
    if (!['pending', 'placed'].includes(rows[0].status)) {
      throw new HttpError(409, `A ${rows[0].status} order cannot be cancelled here`);
    }
    await releaseOrder(client, orderId, userId, { restoreCart: false });
  });
  return getOrder(userId, orderId);
}
