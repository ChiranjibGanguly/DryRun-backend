import { pool, query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';
import { slugify } from '../utils/slugify.js';

const SORTS = {
  newest: 'b.created_at DESC, b.id',
  price_asc: 'b.price_paise ASC, b.id',
  price_desc: 'b.price_paise DESC, b.id',
  title: 'lower(b.title) ASC, b.id',
};
export const SORT_OPTIONS = Object.keys(SORTS);

const BOOK_SELECT = `
  SELECT b.*, a.name AS author_name,
         COALESCE(
           json_agg(json_build_object('id', c.id, 'name', c.name, 'slug', c.slug) ORDER BY c.name)
             FILTER (WHERE c.id IS NOT NULL),
           '[]'
         ) AS categories
  FROM books b
  LEFT JOIN authors a ON a.id = b.author_id
  LEFT JOIN book_categories bc ON bc.book_id = b.id
  LEFT JOIN categories c ON c.id = bc.category_id`;

export function toBook(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    author: row.author_id ? { id: row.author_id, name: row.author_name } : null,
    description: row.description,
    isbn: row.isbn,
    publisher: row.publisher,
    language: row.language,
    pages: row.pages,
    pricePaise: row.price_paise,
    mrpPaise: row.mrp_paise,
    stock: row.stock,
    coverUrl: row.cover_url,
    isActive: row.is_active,
    categories: row.categories ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Paged, filtered book list. Inactive books only when includeInactive. */
export async function listBooks({
  q,
  category,
  sort = 'newest',
  page = 1,
  limit = 20,
  includeInactive = false,
}) {
  const where = [];
  const params = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (!includeInactive) where.push('b.is_active');
  if (q) {
    const p = add(`%${escapeLike(q)}%`);
    where.push(`(b.title ILIKE ${p} OR a.name ILIKE ${p} OR b.isbn ILIKE ${p})`);
  }
  if (category) {
    const p = add(category);
    where.push(`EXISTS (
      SELECT 1 FROM book_categories bc2 JOIN categories c2 ON c2.id = bc2.category_id
      WHERE bc2.book_id = b.id AND c2.slug = ${p})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countResult = await query(
    `SELECT count(*)::int AS total FROM books b LEFT JOIN authors a ON a.id = b.author_id ${whereSql}`,
    params,
  );
  const total = countResult.rows[0].total;

  const limitP = add(limit);
  const offsetP = add((page - 1) * limit);
  const { rows } = await query(
    `${BOOK_SELECT} ${whereSql}
     GROUP BY b.id, a.name
     ORDER BY ${SORTS[sort] ?? SORTS.newest}
     LIMIT ${limitP} OFFSET ${offsetP}`,
    params,
  );

  return {
    items: rows.map(toBook),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function findBook(column, value, { includeInactive = false } = {}) {
  const { rows } = await query(
    `${BOOK_SELECT} WHERE b.${column} = $1 ${includeInactive ? '' : 'AND b.is_active'}
     GROUP BY b.id, a.name`,
    [value],
  );
  return rows[0] ? toBook(rows[0]) : null;
}

export const getBookBySlug = (slug, opts) => findBook('slug', slug, opts);
export const getBookById = (id, opts) => findBook('id', id, opts);

export async function listCategories() {
  const { rows } = await query(`
    SELECT c.id, c.name, c.slug, count(b.id)::int AS book_count
    FROM categories c
    LEFT JOIN book_categories bc ON bc.category_id = c.id
    LEFT JOIN books b ON b.id = bc.book_id AND b.is_active
    GROUP BY c.id
    ORDER BY c.name`);
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, bookCount: r.book_count }));
}

export async function listAuthors() {
  const { rows } = await query('SELECT id, name, bio FROM authors ORDER BY lower(name)');
  return rows;
}

export async function createAuthor({ name, bio }) {
  const { rows } = await query(
    'INSERT INTO authors (name, bio) VALUES ($1, $2) RETURNING id, name, bio',
    [name, bio ?? null],
  );
  return rows[0];
}

// ---------- writes (admin) ----------

async function resolveAuthorId(client, { authorId, authorName }) {
  if (authorId) {
    const { rowCount } = await client.query('SELECT 1 FROM authors WHERE id = $1', [authorId]);
    if (!rowCount) throw new HttpError(400, 'Unknown author');
    return authorId;
  }
  if (authorName) {
    const found = await client.query('SELECT id FROM authors WHERE lower(name) = lower($1) LIMIT 1', [authorName]);
    if (found.rows[0]) return found.rows[0].id;
    const created = await client.query('INSERT INTO authors (name) VALUES ($1) RETURNING id', [authorName]);
    return created.rows[0].id;
  }
  return undefined;
}

async function uniqueSlug(client, title, excludeId) {
  const base = slugify(title);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const { rowCount } = await client.query(
      'SELECT 1 FROM books WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2)',
      [candidate, excludeId ?? null],
    );
    if (!rowCount) return candidate;
  }
}

async function setCategories(client, bookId, slugs) {
  const unique = [...new Set(slugs)];
  const { rows } = await client.query('SELECT id, slug FROM categories WHERE slug = ANY($1)', [unique]);
  if (rows.length !== unique.length) {
    const known = new Set(rows.map((r) => r.slug));
    throw new HttpError(400, `Unknown category: ${unique.filter((s) => !known.has(s)).join(', ')}`);
  }
  await client.query('DELETE FROM book_categories WHERE book_id = $1', [bookId]);
  for (const r of rows) {
    await client.query('INSERT INTO book_categories (book_id, category_id) VALUES ($1, $2)', [bookId, r.id]);
  }
}

const COLUMNS = {
  title: 'title',
  description: 'description',
  isbn: 'isbn',
  publisher: 'publisher',
  language: 'language',
  pages: 'pages',
  pricePaise: 'price_paise',
  mrpPaise: 'mrp_paise',
  stock: 'stock',
  coverUrl: 'cover_url',
  isActive: 'is_active',
};

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505' && String(err.constraint).includes('isbn')) {
      throw new HttpError(409, 'A book with this ISBN already exists');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function createBook(input) {
  const id = await inTransaction(async (client) => {
    const authorId = await resolveAuthorId(client, input);
    const slug = await uniqueSlug(client, input.title);
    const cols = ['slug', 'author_id'];
    const vals = [slug, authorId ?? null];
    for (const [key, col] of Object.entries(COLUMNS)) {
      if (input[key] !== undefined) {
        cols.push(col);
        vals.push(input[key]);
      }
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await client.query(
      `INSERT INTO books (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals,
    );
    if (input.categorySlugs) await setCategories(client, rows[0].id, input.categorySlugs);
    return rows[0].id;
  });
  return getBookById(id, { includeInactive: true });
}

export async function updateBook(id, input) {
  const existing = await getBookById(id, { includeInactive: true });
  if (!existing) throw new HttpError(404, 'Book not found');

  const mrp = input.mrpPaise !== undefined ? input.mrpPaise : existing.mrpPaise;
  const price = input.pricePaise ?? existing.pricePaise;
  if (mrp != null && mrp < price) throw new HttpError(400, 'MRP cannot be lower than the price');

  await inTransaction(async (client) => {
    const sets = [];
    const vals = [];
    const set = (col, v) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    for (const [key, col] of Object.entries(COLUMNS)) {
      if (input[key] !== undefined) set(col, input[key]);
    }
    if (input.title !== undefined && input.title !== existing.title) {
      set('slug', await uniqueSlug(client, input.title, id));
    }
    if (input.authorId !== undefined || input.authorName !== undefined) {
      set('author_id', (await resolveAuthorId(client, input)) ?? null);
    }
    if (sets.length) {
      vals.push(id);
      await client.query(`UPDATE books SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    if (input.categorySlugs) await setCategories(client, id, input.categorySlugs);
  });
  return getBookById(id, { includeInactive: true });
}

export async function deleteBook(id) {
  const { rowCount } = await query('DELETE FROM books WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Book not found');
}
