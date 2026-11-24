import { config } from '../config.js';
import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

export function shippingFor(subtotalPaise) {
  if (subtotalPaise === 0) return 0;
  return subtotalPaise >= config.freeShippingMinPaise ? 0 : config.shippingFeePaise;
}

export async function getCart(userId) {
  const { rows } = await query(
    `SELECT ci.id, ci.quantity, b.id AS book_id, b.slug, b.title, b.price_paise, b.mrp_paise,
            b.stock, b.cover_url, b.is_active, a.name AS author_name
     FROM cart_items ci
     JOIN books b ON b.id = ci.book_id
     LEFT JOIN authors a ON a.id = b.author_id
     WHERE ci.user_id = $1
     ORDER BY ci.created_at`,
    [userId],
  );

  const items = rows.map((r) => {
    const available = r.is_active && r.stock > 0;
    return {
      id: r.id,
      quantity: r.quantity,
      book: {
        id: r.book_id,
        slug: r.slug,
        title: r.title,
        author: r.author_name ? { name: r.author_name } : null,
        pricePaise: r.price_paise,
        mrpPaise: r.mrp_paise,
        stock: r.is_active ? r.stock : 0,
        coverUrl: r.cover_url,
      },
      lineTotalPaise: r.price_paise * r.quantity,
      // Problems the customer must fix before checkout.
      issue: !available
        ? 'unavailable'
        : r.quantity > r.stock
          ? 'not_enough_stock'
          : null,
    };
  });

  const subtotalPaise = items.reduce((sum, i) => sum + i.lineTotalPaise, 0);
  const shippingPaise = shippingFor(subtotalPaise);
  return {
    items,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotalPaise,
    shippingPaise,
    totalPaise: subtotalPaise + shippingPaise,
    freeShippingMinPaise: config.freeShippingMinPaise,
    canCheckout: items.length > 0 && items.every((i) => i.issue === null),
  };
}

async function availableBook(bookId) {
  const { rows } = await query('SELECT id, stock, is_active FROM books WHERE id = $1', [bookId]);
  const book = rows[0];
  if (!book || !book.is_active) throw new HttpError(404, 'Book not found');
  return book;
}

/** Adds quantity to the cart line (creating it), capped at stock. */
export async function addToCart(userId, bookId, quantity) {
  const book = await availableBook(bookId);
  if (book.stock < 1) throw new HttpError(409, 'This book is out of stock');
  const { rows } = await query('SELECT quantity FROM cart_items WHERE user_id = $1 AND book_id = $2', [userId, bookId]);
  const current = rows[0]?.quantity ?? 0;
  if (current + quantity > book.stock) {
    throw new HttpError(409, `Only ${book.stock} in stock`);
  }
  await query(
    `INSERT INTO cart_items (user_id, book_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, book_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
    [userId, bookId, quantity],
  );
  return getCart(userId);
}

/** Sets the quantity of a cart line; 0 removes it. */
export async function setCartQuantity(userId, bookId, quantity) {
  if (quantity === 0) return removeFromCart(userId, bookId);
  const { rowCount } = await query('SELECT 1 FROM cart_items WHERE user_id = $1 AND book_id = $2', [userId, bookId]);
  if (!rowCount) throw new HttpError(404, 'This book is not in your cart');
  const book = await availableBook(bookId);
  if (quantity > book.stock) throw new HttpError(409, `Only ${book.stock} in stock`);
  await query('UPDATE cart_items SET quantity = $3 WHERE user_id = $1 AND book_id = $2', [userId, bookId, quantity]);
  return getCart(userId);
}

export async function removeFromCart(userId, bookId) {
  await query('DELETE FROM cart_items WHERE user_id = $1 AND book_id = $2', [userId, bookId]);
  return getCart(userId);
}

export async function clearCart(userId) {
  await query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
  return getCart(userId);
}
