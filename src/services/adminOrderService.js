import { pool, query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';
import { notifyOrder } from './orderService.js';

const ADMIN_ORDER_SELECT = `
  SELECT o.*, u.name AS customer_name, u.email AS customer_email,
    COALESCE(json_agg(json_build_object(
      'bookId', oi.book_id, 'slug', b.slug, 'title', oi.title_snapshot,
      'coverUrl', b.cover_url, 'unitPricePaise', oi.unit_price_paise,
      'quantity', oi.quantity, 'lineTotalPaise', oi.unit_price_paise * oi.quantity
    ) ORDER BY oi.title_snapshot) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
  FROM orders o
  JOIN users u ON u.id = o.user_id
  LEFT JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN books b ON b.id = oi.book_id`;

export function toAdminOrder(r) {
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
    customer: { id: r.user_id, name: r.customer_name, email: r.customer_email },
    razorpayOrderId: r.razorpay_order_id,
    paymentId: r.payment_id,
    trackingNumber: r.tracking_number,
    courier: r.courier,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    shippedAt: r.shipped_at,
    deliveredAt: r.delivered_at,
    cancelledAt: r.cancelled_at,
  };
}

export async function getAdminOrder(id) {
  const { rows } = await query(`${ADMIN_ORDER_SELECT} WHERE o.id = $1 GROUP BY o.id, u.id`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Order not found');
  return toAdminOrder(rows[0]);
}

/** Filter by status ('to_ship' = placed or paid), search by order ref, customer name/email. */
export async function listAdminOrders({ status, q, page = 1, limit = 20 }) {
  const where = [];
  const params = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (status === 'to_ship') where.push(`o.status IN ('placed', 'paid')`);
  else if (status) where.push(`o.status = ${add(status)}`);
  if (q) {
    const ref = q.replace(/^#/, '').toLowerCase();
    const p = add(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const r = add(`${ref.replace(/[^0-9a-f]/g, '')}%`);
    where.push(`(u.email ILIKE ${p} OR u.name ILIKE ${p}
      OR (length(${r}) > 1 AND replace(o.id::text, '-', '') LIKE ${r}))`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: count } = await query(
    `SELECT count(*)::int AS total FROM orders o JOIN users u ON u.id = o.user_id ${whereSql}`,
    params,
  );
  const lp = add(limit);
  const op = add((page - 1) * limit);
  const { rows } = await query(
    `${ADMIN_ORDER_SELECT} ${whereSql} GROUP BY o.id, u.id ORDER BY o.created_at DESC LIMIT ${lp} OFFSET ${op}`,
    params,
  );
  const total = count[0].total;
  return { items: rows.map(toAdminOrder), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function withOrderLocked(id, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HttpError(404, 'Order not found');
    await fn(client, rows[0]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getAdminOrder(id);
}

/**
 * Admin status changes:
 *   placed | paid -> shipped (optional courier + tracking number)
 *   shipped       -> delivered (a cash-on-delivery order is then marked paid)
 *   pending | placed -> cancelled (stock returned). Paid orders need a refund first.
 */
export async function updateOrderStatus(id, { status, trackingNumber, courier }) {
  const result = await withOrderLocked(id, async (client, order) => {
    const from = order.status;
    if (status === 'shipped') {
      if (!['placed', 'paid'].includes(from)) {
        throw new HttpError(409, `Only placed or paid orders can be shipped (this one is ${from})`);
      }
      await client.query(
        `UPDATE orders SET status = 'shipped', shipped_at = now(),
                tracking_number = $2, courier = $3 WHERE id = $1`,
        [id, trackingNumber ?? null, courier ?? null],
      );
    } else if (status === 'delivered') {
      if (from !== 'shipped') {
        throw new HttpError(409, `Only shipped orders can be marked delivered (this one is ${from})`);
      }
      await client.query(
        `UPDATE orders SET status = 'delivered', delivered_at = now(),
           payment_status = CASE WHEN payment_method = 'cod' THEN 'paid'::payment_status ELSE payment_status END,
           paid_at = CASE WHEN payment_method = 'cod' AND paid_at IS NULL THEN now() ELSE paid_at END
         WHERE id = $1`,
        [id],
      );
    } else if (status === 'cancelled') {
      if (!['pending', 'placed'].includes(from)) {
        throw new HttpError(
          409,
          from === 'paid'
            ? 'This order is paid. Refund it in Razorpay first; refunds from here come later.'
            : `A ${from} order cannot be cancelled`,
        );
      }
      const { rows: items } = await client.query(
        'SELECT book_id, quantity FROM order_items WHERE order_id = $1 AND book_id IS NOT NULL',
        [id],
      );
      for (const it of items) {
        await client.query('UPDATE books SET stock = stock + $2 WHERE id = $1', [it.book_id, it.quantity]);
      }
      await client.query(`UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [id]);
    } else {
      throw new HttpError(400, 'Status must be shipped, delivered or cancelled');
    }
  });
  if (status === 'shipped') notifyOrder(id, 'shipped', { courier, trackingNumber });
  if (status === 'cancelled') notifyOrder(id, 'cancelled', { byCustomer: false });
  return result;
}

/** Cash collected for a COD order before it is marked delivered. */
export async function markCodPaid(id) {
  return withOrderLocked(id, async (client, order) => {
    if (order.payment_method !== 'cod') throw new HttpError(409, 'Only cash-on-delivery orders are marked paid here');
    if (order.status === 'cancelled') throw new HttpError(409, 'This order is cancelled');
    if (order.payment_status === 'paid') return;
    await client.query(`UPDATE orders SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [id]);
  });
}

export async function getStats({ lowStockAt = 5 } = {}) {
  const { rows: [o] } = await query(`
    SELECT
      count(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND status <> 'cancelled')::int AS orders_today,
      COALESCE(sum(total_paise) FILTER (WHERE created_at >= date_trunc('day', now()) AND status <> 'cancelled' AND status <> 'pending'), 0)::bigint AS sales_today_paise,
      count(*) FILTER (WHERE status IN ('placed', 'paid'))::int AS to_ship,
      count(*) FILTER (WHERE status = 'shipped')::int AS shipped,
      count(*) FILTER (WHERE status = 'pending')::int AS awaiting_payment,
      COALESCE(sum(total_paise) FILTER (WHERE created_at >= now() - interval '30 days' AND status NOT IN ('cancelled', 'pending')), 0)::bigint AS sales_30d_paise
    FROM orders`);
  const { rows: [b] } = await query(
    `SELECT count(*) FILTER (WHERE is_active)::int AS active_books,
            count(*) FILTER (WHERE is_active AND stock = 0)::int AS out_of_stock
     FROM books`,
  );
  const { rows: low } = await query(
    `SELECT id, slug, title, stock FROM books WHERE is_active AND stock <= $1 ORDER BY stock, title LIMIT 10`,
    [lowStockAt],
  );
  return {
    ordersToday: o.orders_today,
    salesTodayPaise: Number(o.sales_today_paise),
    sales30dPaise: Number(o.sales_30d_paise),
    toShip: o.to_ship,
    shipped: o.shipped,
    awaitingPayment: o.awaiting_payment,
    activeBooks: b.active_books,
    outOfStock: b.out_of_stock,
    lowStock: low,
  };
}
