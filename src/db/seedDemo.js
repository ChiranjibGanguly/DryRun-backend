// Demo data for development: 4 customers with addresses and ~20 orders over
// the last 25 days in every status, so the shop's best sellers and the admin
// dashboard have something to show. Run after `npm run seed`.
//   npm run seed:demo
// Never run this against the live shop database.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
import { shippingFor } from '../services/cartService.js';
import { explainDbError } from './errors.js';

const PASSWORD = 'Demo@12345';
const customers = [
  { name: 'Priya Sharma', email: 'priya.demo@dryrun.local', phone: '9820012345',
    address: { line1: '14 Carter Road, Bandra West', city: 'Mumbai', state: 'Maharashtra', pincode: '400050' } },
  { name: 'Rahul Verma', email: 'rahul.demo@dryrun.local', phone: '9811023456',
    address: { line1: 'B-22 Lajpat Nagar II', city: 'New Delhi', state: 'Delhi', pincode: '110024' } },
  { name: 'Ananya Sen', email: 'ananya.demo@dryrun.local', phone: '9830034567',
    address: { line1: '5/1 Hindustan Park', city: 'Kolkata', state: 'West Bengal', pincode: '700029' } },
  { name: 'Arjun Nair', email: 'arjun.demo@dryrun.local', phone: '9847045678',
    address: { line1: 'Kadavanthra Road, Near Metro', city: 'Kochi', state: 'Kerala', pincode: '682020' } },
];

// [days ago, status, payment method]
const plan = [
  [0, 'placed', 'cod'], [0, 'paid', 'online'], [1, 'paid', 'online'], [1, 'placed', 'cod'],
  [2, 'shipped', 'cod'], [3, 'shipped', 'online'], [4, 'pending', 'online'], [5, 'shipped', 'online'],
  [6, 'delivered', 'cod'], [7, 'delivered', 'online'], [8, 'cancelled', 'cod'], [9, 'delivered', 'online'],
  [11, 'delivered', 'cod'], [12, 'delivered', 'online'], [14, 'delivered', 'online'], [16, 'delivered', 'cod'],
  [18, 'delivered', 'online'], [20, 'delivered', 'online'], [22, 'delivered', 'cod'], [25, 'delivered', 'online'],
];

// Small deterministic random generator, so every run creates the same data.
function random(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const client = await pool.connect();
try {
  const { rows: existing } = await client.query(
    `SELECT count(*)::int AS n FROM orders o JOIN users u ON u.id = o.user_id
     WHERE u.email LIKE '%.demo@dryrun.local'`,
  );
  if (existing[0].n > 0) {
    console.log(`Demo orders already exist (${existing[0].n}). Nothing to do.`);
  } else {
    const { rows: books } = await client.query(
      `SELECT id, title, price_paise, stock FROM books
       WHERE is_active AND stock >= 4 ORDER BY is_featured DESC, created_at LIMIT 40`,
    );
    if (books.length < 5) throw new Error('Run `npm run seed` first: not enough books in stock.');

    await client.query('BEGIN');
    const hash = await bcrypt.hash(PASSWORD, 10);
    const users = [];
    for (const c of customers) {
      const { rows } = await client.query(
        `INSERT INTO users (name, email, password_hash, phone) VALUES ($1, $2, $3, $4)
         ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [c.name, c.email, hash, c.phone],
      );
      const userId = rows[0].id;
      await client.query('DELETE FROM addresses WHERE user_id = $1', [userId]);
      await client.query(
        `INSERT INTO addresses (user_id, name, phone, line1, city, state, pincode, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [userId, c.name, c.phone, c.address.line1, c.address.city, c.address.state, c.address.pincode],
      );
      users.push({ id: userId, snapshot: { name: c.name, phone: c.phone, ...c.address, line2: null, isDefault: true } });
    }

    const rand = random(42);
    // Popular books get picked more often, so "best sellers" has a clear order.
    const pick = () => books[Math.floor(Math.pow(rand(), 2) * books.length)];
    let count = 0;
    for (const [i, [daysAgo, status, method]] of plan.entries()) {
      const user = users[i % users.length];
      const lines = new Map();
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const b = pick();
        lines.set(b.id, { book: b, quantity: Math.min((lines.get(b.id)?.quantity ?? 0) + 1 + Math.floor(rand() * 2), 3) });
      }
      const subtotal = [...lines.values()].reduce((s, l) => s + l.book.price_paise * l.quantity, 0);
      const shipping = shippingFor(subtotal);
      const created = `now() - interval '${daysAgo} days' - interval '${Math.floor(rand() * 8)} hours'`;
      const paid = method === 'online' ? ['paid', 'shipped', 'delivered'].includes(status) : status === 'delivered';
      const { rows } = await client.query(
        `INSERT INTO orders (user_id, address_snapshot, subtotal_paise, shipping_paise, total_paise,
            status, payment_method, payment_status, payment_id, created_at, updated_at, paid_at,
            shipped_at, delivered_at, cancelled_at, courier, tracking_number)
         VALUES ($1, $2, $3, $4, $5, $6::text::order_status, $7::text::payment_method, $8::text::payment_status, $9, ${created}, ${created},
            CASE WHEN $10::boolean THEN ${created} + interval '10 minutes' END,
            CASE WHEN $6::text IN ('shipped', 'delivered') THEN ${created} + interval '1 day' END,
            CASE WHEN $6::text = 'delivered' THEN ${created} + interval '3 days' END,
            CASE WHEN $6::text = 'cancelled' THEN ${created} + interval '2 hours' END,
            CASE WHEN $6::text IN ('shipped', 'delivered') THEN $11::text END,
            CASE WHEN $6::text IN ('shipped', 'delivered') THEN $12::text END)
         RETURNING id`,
        [
          user.id, JSON.stringify(user.snapshot), subtotal, shipping, subtotal + shipping,
          status, method, paid ? 'paid' : 'unpaid', method === 'online' && paid ? `pay_demo_${i}` : null,
          paid, i % 2 ? 'Delhivery' : 'India Post', `DEMO${100000 + i}IN`,
        ],
      );
      for (const { book, quantity } of lines.values()) {
        await client.query(
          `INSERT INTO order_items (order_id, book_id, title_snapshot, unit_price_paise, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [rows[0].id, book.id, book.title, book.price_paise, quantity],
        );
        if (status !== 'cancelled') {
          await client.query('UPDATE books SET stock = GREATEST(stock - $2, 0) WHERE id = $1', [book.id, quantity]);
        }
      }
      count++;
    }
    await client.query('COMMIT');
    console.log(`Created ${customers.length} demo customers (password ${PASSWORD}) and ${count} demo orders.`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(explainDbError(err));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
