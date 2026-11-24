// Seeds the admin account (ADMIN_* env vars), categories and sample books.
// Safe to run more than once.
import 'dotenv/config';
import { pool, query } from './pool.js';
import { createUser } from '../services/userService.js';
import { createBook } from '../services/catalogService.js';
import { sampleBooks } from '../data/sampleBooks.js';
import { slugify } from '../utils/slugify.js';
import { explainDbError } from './errors.js';

const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME = 'Store Admin' } = process.env;

const categories = [
  ['Fiction', 'fiction'],
  ['Non-fiction', 'non-fiction'],
  ['Children', 'children'],
  ['Academic', 'academic'],
  ['Comics', 'comics'],
];

try {
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const { rows } = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [ADMIN_EMAIL]);
    if (rows.length) {
      await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [rows[0].id]);
      console.log(`Admin ${ADMIN_EMAIL} already exists (role ensured)`);
    } else {
      await createUser({ name: ADMIN_NAME, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'admin' });
      console.log(`Created admin ${ADMIN_EMAIL}`);
    }
  } else {
    console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set, skipping admin');
  }

  for (const [name, slug] of categories) {
    await query(
      'INSERT INTO categories (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING',
      [name, slug],
    );
  }
  console.log(`Seeded ${categories.length} categories`);

  let added = 0;
  for (const b of sampleBooks) {
    const { rowCount } = await query('SELECT 1 FROM books WHERE slug = $1', [slugify(b.title)]);
    if (rowCount) continue;
    await createBook({
      title: b.title,
      authorName: b.author,
      description: b.description,
      language: b.language,
      pricePaise: b.price,
      mrpPaise: b.mrp,
      stock: b.stock,
      categorySlugs: b.categories,
    });
    added++;
  }
  console.log(`Sample books: ${added} added, ${sampleBooks.length - added} already there`);
} catch (err) {
  console.error(explainDbError(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
