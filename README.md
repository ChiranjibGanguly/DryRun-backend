# DryRun Books – Backend

Node.js + Express API for the DryRun book selling platform, with PostgreSQL
(`pg` + plain SQL migrations) and JWT authentication.

The Flutter web app lives in its own repository.

## Setup

Requires Node.js 22+ and PostgreSQL 16 (Postgres.app) on port 5432.

```bash
npm install
cp .env.example .env    # set DATABASE_URL (with your Postgres password) and JWT_SECRET
npm run db:create       # creates the "dryrun" database
npm run migrate         # applies src/db/migrations/*.sql
npm run seed            # admin account, categories, 22 sample books
npm run dev             # http://localhost:3000, restarts on changes
npm test                # integration tests (need the database)
```

Default admin (from `.env`): `admin@dryrun.local` / `Admin@12345` – change it before deploying.

## Database migrations

Add a new file in `backend/src/db/migrations/` named with the next number
(e.g. `002_add_wishlist.sql`) and run `npm run migrate`. Never edit a migration
that has already been applied; add a new one instead.

## API

Prices are integers in paise (₹1 = 100 paise). Lists return
`{ items, page, limit, total, totalPages }`.

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | – | API + database status |
| POST | `/api/auth/register` | – | `{ name, email, password }` → `{ token, user }` |
| POST | `/api/auth/login` | – | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | Bearer token | Current user |

### Catalogue (public)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/books` | `?q=` (title, author, ISBN) `&category=<slug>` `&sort=newest\|price_asc\|price_desc\|title` `&page=1&limit=20` (max 50) |
| GET | `/api/books/:slug` | One active book with author and categories |
| GET | `/api/categories` | Categories with active book counts |
| GET | `/api/authors` | All authors |

### Admin (admin token required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/books` | Same filters as `/api/books`, includes inactive books |
| GET | `/api/admin/books/:id` | One book by id |
| POST | `/api/admin/books` | `{ title, pricePaise, mrpPaise?, stock?, authorId? \| authorName?, description?, isbn?, publisher?, language?, pages?, coverUrl?, isActive?, categorySlugs? }` |
| PATCH | `/api/admin/books/:id` | Any of the fields above |
| DELETE | `/api/admin/books/:id` | Delete a book (past orders keep their snapshot) |
| POST | `/api/admin/authors` | `{ name, bio? }` |
| POST | `/api/admin/uploads/cover` | multipart field `file` (JPEG/PNG/WebP, max 2 MB) → `{ url }`; use it as `coverUrl` |

Uploaded covers are stored in `backend/uploads/` and served at `/uploads/...`
(moving to Cloudinary before launch).

Errors are returned as `{ "error": "message" }` (validation errors add `details`).
