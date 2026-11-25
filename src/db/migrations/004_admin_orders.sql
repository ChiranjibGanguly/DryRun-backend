-- Phase 4: admin order handling.
ALTER TABLE orders
  ADD COLUMN shipped_at      TIMESTAMPTZ,
  ADD COLUMN delivered_at    TIMESTAMPTZ,
  ADD COLUMN tracking_number TEXT,
  ADD COLUMN courier         TEXT;

CREATE INDEX books_stock_idx ON books (stock) WHERE is_active;
