import { parse } from 'csv-parse/sync';
import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';
import { createBook, updateBook } from './catalogService.js';

export const IMPORT_COLUMNS = [
  'title', 'author', 'price', 'mrp', 'stock', 'isbn', 'language',
  'publisher', 'pages', 'categories', 'description', 'cover_url', 'active', 'featured',
];

export const IMPORT_TEMPLATE =
  `${IMPORT_COLUMNS.join(',')}\n` +
  'The Guide,R. K. Narayan,299,350,12,9780000000001,English,Indian Thought Publications,220,fiction,"A guide becomes a holy man by accident.",,yes,yes\n' +
  'Panchatantra Stories,Vishnu Sharma,159,199,40,,English,,,children;fiction,Animal fables for young readers.,,yes,no\n';

const MAX_ROWS = 2000;

/** "₹1,299.50" -> 129950 paise; null for empty; NaN for junk. */
function rupeesToPaise(value) {
  const v = String(value ?? '').replace(/[₹,\s]/g, '');
  if (v === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  return Math.round(Number(v) * 100);
}

function intOrNull(value) {
  const v = String(value ?? '').trim();
  if (v === '') return null;
  return /^\d+$/.test(v) ? Number(v) : Number.NaN;
}

const yes = (v) => !/^(no|n|false|0|inactive)$/i.test(String(v ?? '').trim());

/** Validates one CSV row and turns it into createBook/updateBook input. */
function toBookInput(row, categoriesByKey) {
  const errors = [];
  const title = (row.title ?? '').trim();
  if (!title) errors.push('title is required');
  if (title.length > 200) errors.push('title is longer than 200 characters');

  const pricePaise = rupeesToPaise(row.price);
  if (pricePaise === null) errors.push('price is required');
  else if (Number.isNaN(pricePaise)) errors.push(`price "${row.price}" is not a number`);

  const mrpPaise = rupeesToPaise(row.mrp);
  if (Number.isNaN(mrpPaise)) errors.push(`mrp "${row.mrp}" is not a number`);
  else if (mrpPaise !== null && pricePaise !== null && !Number.isNaN(pricePaise) && mrpPaise < pricePaise) {
    errors.push('mrp is lower than price');
  }

  const stock = intOrNull(row.stock);
  if (Number.isNaN(stock)) errors.push(`stock "${row.stock}" is not a whole number`);
  const pages = intOrNull(row.pages);
  if (Number.isNaN(pages) || pages === 0) errors.push(`pages "${row.pages}" is not a positive whole number`);

  const isbn = (row.isbn ?? '').trim().replace(/\s/g, '') || null;
  if (isbn && !/^[0-9Xx-]{10,17}$/.test(isbn)) errors.push(`isbn "${isbn}" should be 10 or 13 digits`);

  const coverUrl = (row.cover_url ?? '').trim() || null;
  if (coverUrl && !/^https?:\/\//.test(coverUrl)) errors.push('cover_url must start with http:// or https://');

  const categorySlugs = [];
  for (const raw of String(row.categories ?? '').split(/[;|]/)) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const slug = categoriesByKey.get(key);
    if (slug) categorySlugs.push(slug);
    else errors.push(`unknown category "${raw.trim()}"`);
  }

  return {
    errors,
    input: {
      title,
      authorName: (row.author ?? '').trim() || undefined,
      pricePaise,
      mrpPaise,
      stock: stock ?? 0,
      isbn,
      language: (row.language ?? '').trim() || null,
      publisher: (row.publisher ?? '').trim() || null,
      pages,
      description: (row.description ?? '').trim() || null,
      coverUrl,
      isActive: yes(row.active),
      // Empty/missing "featured" leaves an existing book's setting as it is.
      isFeatured: String(row.featured ?? '').trim() === ''
        ? undefined
        : /^(yes|y|true|1)$/i.test(String(row.featured).trim()),
      categorySlugs,
    },
  };
}

/**
 * Imports books from CSV text. Rows with an ISBN that already exists update
 * that book; other rows create new books. With dryRun nothing is written.
 * Returns { dryRun, total, created, updated, failed, rows: [{ row, title, action, errors }] }.
 */
export async function importBooksCsv(text, { dryRun = false } = {}) {
  let records;
  try {
    records = parse(text.replace(/^﻿/, ''), {
      columns: (header) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (err) {
    throw new HttpError(400, `Could not read the CSV: ${err.message}`);
  }
  if (!records.length) throw new HttpError(400, 'The CSV has no rows');
  if (records.length > MAX_ROWS) throw new HttpError(400, `At most ${MAX_ROWS} rows per file`);
  if (!('title' in records[0]) || !('price' in records[0])) {
    throw new HttpError(400, `The first line must be the column names; title and price are required. Columns: ${IMPORT_COLUMNS.join(', ')}`);
  }

  const { rows: cats } = await query('SELECT name, slug FROM categories');
  const categoriesByKey = new Map();
  for (const c of cats) {
    categoriesByKey.set(c.slug.toLowerCase(), c.slug);
    categoriesByKey.set(c.name.toLowerCase(), c.slug);
  }

  const isbns = records.map((r) => (r.isbn ?? '').trim().replace(/\s/g, '')).filter(Boolean);
  const { rows: existing } = await query('SELECT id, isbn FROM books WHERE isbn = ANY($1)', [isbns]);
  const idByIsbn = new Map(existing.map((b) => [b.isbn, b.id]));

  const seenIsbn = new Set();
  const results = [];
  for (const [i, record] of records.entries()) {
    const rowNumber = i + 2; // line 1 is the header
    const { errors, input } = toBookInput(record, categoriesByKey);
    if (input.isbn) {
      if (seenIsbn.has(input.isbn)) errors.push(`isbn ${input.isbn} appears twice in this file`);
      seenIsbn.add(input.isbn);
    }
    const existingId = input.isbn ? idByIsbn.get(input.isbn) : undefined;
    const action = existingId ? 'update' : 'create';

    if (errors.length) {
      results.push({ row: rowNumber, title: input.title, action: 'error', errors });
      continue;
    }
    if (!dryRun) {
      try {
        if (existingId) await updateBook(existingId, input);
        else await createBook(input);
      } catch (err) {
        results.push({ row: rowNumber, title: input.title, action: 'error', errors: [err.message] });
        continue;
      }
    }
    results.push({ row: rowNumber, title: input.title, action, errors: [] });
  }

  return {
    dryRun,
    total: results.length,
    created: results.filter((r) => r.action === 'create').length,
    updated: results.filter((r) => r.action === 'update').length,
    failed: results.filter((r) => r.action === 'error').length,
    rows: results,
  };
}
