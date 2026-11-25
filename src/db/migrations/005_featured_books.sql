-- Books the shop wants to show off on the home page.
ALTER TABLE books ADD COLUMN is_featured BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX books_featured_idx ON books (is_featured) WHERE is_active AND is_featured;

-- Shop sections.
INSERT INTO categories (name, slug) VALUES ('Poetry', 'poetry'), ('History', 'history')
ON CONFLICT (slug) DO NOTHING;
