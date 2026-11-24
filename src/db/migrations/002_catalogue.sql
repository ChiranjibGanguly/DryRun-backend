-- Indexes for catalogue browsing and search.
CREATE INDEX books_created_at_idx ON books (created_at DESC);
CREATE INDEX books_price_idx ON books (price_paise);
CREATE INDEX authors_name_lower_idx ON authors (lower(name));
CREATE INDEX book_categories_category_idx ON book_categories (category_id);
