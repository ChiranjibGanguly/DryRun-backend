-- Phase 3: checkout. Recipient details on addresses, payment fields on orders.

CREATE TYPE payment_method AS ENUM ('online', 'cod');
CREATE TYPE payment_status AS ENUM ('unpaid', 'paid', 'refunded');

-- 'placed': a cash-on-delivery order confirmed and waiting to ship.
-- (pending = waiting for online payment, paid = paid online.)
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'placed' AFTER 'pending';

ALTER TABLE addresses
  ADD COLUMN name  TEXT NOT NULL DEFAULT '',
  ADD COLUMN phone TEXT NOT NULL DEFAULT '';

-- At most one default address per user.
CREATE UNIQUE INDEX addresses_one_default_idx ON addresses (user_id) WHERE is_default;

ALTER TABLE orders
  ADD COLUMN subtotal_paise  INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_paise >= 0),
  ADD COLUMN shipping_paise  INTEGER NOT NULL DEFAULT 0 CHECK (shipping_paise >= 0),
  ADD COLUMN payment_method  payment_method NOT NULL DEFAULT 'online',
  ADD COLUMN payment_status  payment_status NOT NULL DEFAULT 'unpaid',
  ADD COLUMN paid_at         TIMESTAMPTZ,
  ADD COLUMN cancelled_at    TIMESTAMPTZ;

CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
CREATE INDEX cart_items_user_idx ON cart_items (user_id);
