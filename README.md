# stemlab-drinks

A drink ordering web app built for WHS Cyber's Stemlab. Students browse a menu, place orders by name, and staff fulfill them from a live dashboard. No accounts needed — staff authenticate with a PIN.

**Live instance:** `http://172.16.10.58:3000` (internal) | `drinks.velocit.ee` (Cloudflare Tunnel)
**Host:** dolus — Ubuntu 24.04, VLAN 10 Lab
**Source on server:** `/home/ferry/stemlab-drinks/`

---

## Pages

| Page | URL | Access | Description |
|------|-----|--------|-------------|
| Customer Order Page | `/` | Public | Browse menu, add items to cart, submit order |
| Staff Dashboard | `/staff.html` | PIN required | View live orders, mark fulfilled or cancelled, clear all orders |
| Menu Editor | `/menu.html` | PIN required | Add, edit, remove drinks and toggle availability |
| Group / Bulk Order | `/inventory.html` | PIN required | Place large orders on behalf of a group |

---

## Architecture

```
Browser (student / staff)
        │
        │ HTTP :3000
        ▼
┌──────────────────────────────────────┐
│       Node.js / Express Backend      │  stemlab-drinks-backend-1
│                                      │  (Docker container, node:20-alpine)
│  Middleware:                         │
│    Helmet (CSP, security headers)   │
│    express-rate-limit (per-IP)       │
│  Static files: /app/public (ro)     │
└──────────────────┬───────────────────┘
                   │ SQL (pg driver)
                   ▼
┌──────────────────────────────────────┐
│           PostgreSQL 16              │  stemlab-drinks-db-1
│           DB: stemlab                │  (Docker container)
│           User: stemlab              │
│           Volume: pgdata             │
└──────────────────────────────────────┘
```

Deployed with Docker Compose (`compose.yml`). Both containers are managed together.

---

## Getting Started

### Prerequisites

- Docker and Docker Compose

### Setup

1. Clone the repo:
   ```bash
   git clone git@github.com:Wiesbaden-Cyber/stemlab-drinks.git
   cd stemlab-drinks
   ```

2. Copy the environment file and fill in your values:
   ```bash
   cp .env.example .env
   nano .env
   ```

3. Start the stack:
   ```bash
   docker compose up -d
   ```

4. The app is now running at `http://localhost:3000`.

### First Run

On first start, PostgreSQL runs the schema migration at `db/init/001_schema.sql`, which:
- Creates the `drinks`, `orders`, and `order_items` tables
- Seeds the default menu (13 items, all $1.00)
- Creates the `order_number_seq` starting at 1000

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | — | PostgreSQL database name |
| `POSTGRES_USER` | — | PostgreSQL username |
| `POSTGRES_PASSWORD` | — | PostgreSQL password |
| `ADMIN_PIN` | `4321` | Staff PIN for all admin endpoints |
| `ORDER_RETENTION_HOURS` | `24` | Orders older than this are auto-purged |
| `PORT` | `3000` | Port the backend listens on |

---

## Project Structure

```
stemlab-drinks/
├── compose.yml                  # Docker Compose stack definition
├── .env.example                 # Environment variable template
├── backend/
│   ├── Dockerfile               # node:20-alpine, installs deps, runs server.js
│   ├── package.json
│   └── src/
│       ├── server.js            # Express app — all routes, rate limiting, purge job
│       └── db.js                # pg Pool via DATABASE_URL
├── db/
│   └── init/
│       └── 001_schema.sql       # Schema + seed data (runs once on first start)
└── public/                      # Static files served directly by Express
    ├── index.html               # Customer order page
    ├── staff.html               # Staff order dashboard (PIN protected)
    ├── menu.html                # Menu editor (PIN protected)
    └── inventory.html           # Group/bulk order tool (PIN protected)
```

---

## Database Schema

### `drinks`
| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `name` | TEXT UNIQUE NOT NULL | Drink name |
| `price` | NUMERIC(10,2) | Must be ≥ 0 |
| `is_available` | BOOLEAN | When false, hidden from public menu |
| `sort_order` | INT | Controls display order (ASC) |
| `category` | TEXT | e.g. `Soda`, `Water`, `Juice` |
| `notes` | TEXT | Optional note shown to customers (e.g. `Counts as one item`) |
| `updated_at` | TIMESTAMPTZ | Auto-updated on PATCH |

### `orders`
| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | Internal ID |
| `order_number` | BIGINT | Customer-facing number, starts at 1000 |
| `customer_name` | TEXT NOT NULL | Trimmed, required |
| `total_cost` | NUMERIC(10,2) | Calculated server-side — not trusted from client |
| `status` | ENUM | `new` → `in_progress` → `fulfilled` / `cancelled` |
| `created_at` | TIMESTAMPTZ | |
| `fulfilled_at` | TIMESTAMPTZ | Set when status = `fulfilled` |

### `order_items`
| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `order_id` | FK → orders | CASCADE delete |
| `drink_id` | FK → drinks | SET NULL if drink deleted (preserves history) |
| `drink_name` | TEXT | Snapshot of name at order time |
| `unit_price` | NUMERIC(10,2) | Snapshot of price at order time |
| `quantity` | INT | |
| `line_total` | NUMERIC(10,2) | |

Price and name are snapshotted in `order_items` so order history stays accurate even if the menu changes later.

---

## API Reference

All admin endpoints require the `X-Admin-Pin: <PIN>` request header.

### Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth` | Admin | Verify PIN — returns `{ok: true}` or 401 |

### Menu

| Method | Endpoint | Auth | Body / Params | Description |
|--------|----------|------|---------------|-------------|
| GET | `/api/menu` | Public | `?all=1` includes unavailable | List available drinks |
| POST | `/api/menu` | Admin | `{name, price, is_available, sort_order, category, notes}` | Add a drink |
| PATCH | `/api/menu/:id` | Admin | Any subset of drink fields | Update a drink |
| DELETE | `/api/menu/:id` | Admin | — | Remove a drink |

### Orders

| Method | Endpoint | Auth | Body / Params | Description |
|--------|----------|------|---------------|-------------|
| POST | `/api/orders` | Public | `{customerName, items:[{drinkId, quantity}]}` | Place an order |
| GET | `/api/orders` | Admin | `?status=new\|in_progress\|fulfilled\|cancelled` | List orders (last 200) |
| PATCH | `/api/orders/:id/fulfill` | Admin | — | Mark order fulfilled |
| PATCH | `/api/orders/:id/cancel` | Admin | — | Cancel an open order |
| DELETE | `/api/orders` | Admin | — | Flush all orders permanently |

#### Order placement (`POST /api/orders`)

The server:
1. Validates `customerName` and `items` array
2. Looks up each `drinkId` in the DB — rejects if not found or `is_available=false`
3. Reads prices from the DB (client-submitted prices are ignored)
4. Calculates `line_total` and `total_cost` server-side
5. Inserts `orders` and `order_items` in a transaction
6. Returns `{ok, orderId, orderNumber, status, createdAt}`

---

## Security

| Control | Detail |
|---------|--------|
| Rate limiting — PIN | 5 attempts / IP / 15 min |
| Rate limiting — orders | 20 orders / IP / 10 min |
| Helmet CSP | `default-src 'self'`, `script-src 'self' 'unsafe-inline'`, no external resources |
| Admin auth | Header-based `X-Admin-Pin`, never in URL or response body |
| Price integrity | Prices always read from DB at order time — clients cannot manipulate pricing |
| Input validation | All fields validated before any DB query |
| SQL injection | Parameterized queries throughout (`$1, $2, ...`) |
| Order history | `drink_name` and `unit_price` snapshotted so history survives menu changes |

---

## Auto-Purge

Orders older than `ORDER_RETENTION_HOURS` (default 24 h) are automatically deleted.

- Runs once at startup
- Runs every hour (`setInterval`)
- Staff can also manually flush all orders via the "Clear All Orders" button or `DELETE /api/orders`

---

## Default Menu (seeded on first start)

| Name | Price | Category | Notes |
|------|-------|----------|-------|
| Coke | $1.00 | Soda | |
| Cherry Coke | $1.00 | Soda | |
| Sprite | $1.00 | Soda | |
| Canada Dry Gingerale | $1.00 | Soda | |
| Orange Sunkist | $1.00 | Soda | |
| Grape Sunkist | $1.00 | Soda | |
| Dr. Pepper | $1.00 | Soda | |
| A&W Root Beer | $1.00 | Soda | |
| Mt. Dew | $1.00 | Soda | |
| Water | $1.00 | Water | |
| Sparkling Water | $1.00 | Water | |
| La Croix | $1.00 | Water | |
| Capri-Sun (2-pack) | $1.00 | Juice | Counts as one item |

Accepts USD and EUR 1:1.

---

## Useful Commands

```bash
# SSH to the server
ssh ferry@172.16.10.58

# View running containers
docker ps

# View backend logs (live)
docker logs stemlab-drinks-backend-1 -f

# Restart the stack
cd /home/ferry/stemlab-drinks && docker compose restart

# Rebuild after code changes
docker compose up -d --build

# Connect to the database
docker exec -it stemlab-drinks-db-1 psql -U stemlab -d stemlab

# Query current menu
docker exec -it stemlab-drinks-db-1 psql -U stemlab -d stemlab -c "SELECT name, price, is_available, category FROM drinks ORDER BY sort_order;"

# Query open orders
docker exec -it stemlab-drinks-db-1 psql -U stemlab -d stemlab -c "SELECT order_number, customer_name, total_cost, status, created_at FROM orders WHERE status='new' ORDER BY created_at;"
```
