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
| POST | `/api/auth/change-password` | Bearer token | `{ currentPassword, newPassword }` |

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

### Admin: dashboard, orders and CSV import (admin token required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/stats` | `{ ordersToday, salesTodayPaise, sales30dPaise, toShip, shipped, awaitingPayment, activeBooks, outOfStock, lowStock[] }` |
| GET | `/api/admin/orders` | `?status=pending\|placed\|paid\|shipped\|delivered\|cancelled\|to_ship` `&q=` (order ref like `#3F2A9C1E`, customer name or email) `&page&limit` |
| GET | `/api/admin/orders/:id` | Order with customer, items, address, payment and shipping details |
| PATCH | `/api/admin/orders/:id/status` | `{ status: "shipped", courier?, trackingNumber? }` (from placed/paid), `{ status: "delivered" }` (from shipped; COD becomes paid), `{ status: "cancelled" }` (pending/placed; stock returned) |
| POST | `/api/admin/orders/:id/mark-paid` | Cash collected for a COD order |
| GET | `/api/admin/books/import/template` | CSV template |
| POST | `/api/admin/books/import` | multipart `file` (CSV, max 2 MB, 2000 rows). `?dryRun=1` checks without saving. Rows with an existing ISBN update that book; others are created. → `{ created, updated, failed, rows: [{ row, title, action, errors }] }` |

CSV columns (first line): `title, author, price, mrp, stock, isbn, language, publisher, pages, categories, description, cover_url, active`.
`title` and `price` are required; prices in rupees (`299`, `₹1,299.50`); categories by name or slug, separated by `;`; `active` = yes/no.

### Cart (login required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cart` | `{ items, itemCount, subtotalPaise, shippingPaise, totalPaise, canCheckout }`; each item may carry `issue`: `unavailable` / `not_enough_stock` |
| POST | `/api/cart/items` | `{ bookId, quantity? }` adds to the cart (capped at stock) |
| PATCH | `/api/cart/items/:bookId` | `{ quantity }` (0 removes) |
| DELETE | `/api/cart/items/:bookId` | Remove one book |
| DELETE | `/api/cart` | Empty the cart |

Shipping: ₹49 below ₹499, free from ₹499 (`SHIPPING_FEE_PAISE`, `FREE_SHIPPING_MIN_PAISE`).

### Addresses (login required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/addresses` | Default first |
| POST | `/api/addresses` | `{ name, phone, line1, line2?, city, state, pincode, isDefault? }` – 10-digit Indian mobile, 6-digit PIN |
| PATCH | `/api/addresses/:id` | Any of the fields |
| DELETE | `/api/addresses/:id` | Another address becomes default |

### Orders and payments

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/payments/config` | – | `{ online, cod, razorpayKeyId }` – which payment options to show |
| POST | `/api/orders` | user | `{ addressId, paymentMethod: "cod" \| "online" }` – turns the cart into an order and reserves stock. COD → status `placed`. Online → status `pending` + `payment` details for Razorpay Checkout |
| GET | `/api/orders` | user | My orders, newest first (`?page&limit`) |
| GET | `/api/orders/:id` | user | One order with items and address |
| POST | `/api/orders/:id/payment` | user | Payment details again for a pending online order |
| POST | `/api/orders/:id/cancel` | user | Cancel a `pending` or `placed` order; stock is put back |
| POST | `/api/payments/verify` | user | `{ orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature }` – checks the signature, marks the order `paid` |
| POST | `/api/payments/webhook` | Razorpay signature | `payment.captured` / `order.paid` mark the order paid (backup for verify) |

Order status: `pending` (waiting for online payment) → `paid`, or `placed` (cash on delivery) → `shipped` → `delivered`; `cancelled`.

**Razorpay setup:** put your **test** keys in `.env` (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`).
Until both are set, online payment is switched off and only cash on delivery is offered.
For the webhook, add `https://<your-api>/api/payments/webhook` in the Razorpay dashboard with
events `payment.captured` and `order.paid`, and put its secret in `RAZORPAY_WEBHOOK_SECRET`.

Uploaded covers are stored in `backend/uploads/` and served at `/uploads/...`
(moving to Cloudinary before launch).

## Emails

Order confirmation (COD placed / online paid), shipped (with courier and tracking) and
cancelled emails are sent in the background through [Resend](https://resend.com) when
`RESEND_API_KEY` is set; otherwise they are printed in the backend console.
An email problem never blocks an order. Settings: `RESEND_API_KEY`, `EMAIL_FROM`, `SHOP_URL`.

## Security

- Security headers (helmet); `x-powered-by` hidden.
- Rate limits per IP: login, register and change password `RATE_LIMIT_AUTH` (20) per
  `RATE_LIMIT_WINDOW_MINUTES` (15); all other API calls `RATE_LIMIT_API` (1500). Answer: 429.
- `CORS_ORIGIN`: comma-separated list of web app addresses.
- `TRUST_PROXY=1` behind Render/Railway/Nginx so limits see the real client IP.
- With `NODE_ENV=production` the API refuses to start if `JWT_SECRET` is shorter than
  32 characters, `CORS_ORIGIN` is `*`, or `ADMIN_PASSWORD` is still the default.

Errors are returned as `{ "error": "message" }` (validation errors add `details`).
