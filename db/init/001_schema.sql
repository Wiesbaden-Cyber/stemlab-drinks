-- ---------- ENUMS ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
    CREATE TYPE order_status AS ENUM ('new','in_progress','fulfilled','cancelled');
  END IF;
END$$;

-- ---------- DRINKS ----------
CREATE TABLE IF NOT EXISTS drinks (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 100,
  category TEXT NOT NULL DEFAULT 'Drinks',
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drinks_available_idx ON drinks(is_available);
CREATE INDEX IF NOT EXISTS drinks_sort_idx ON drinks(sort_order);

-- Seed menu (EDIT THIS LIST any time)
INSERT INTO drinks (name, price, is_available, sort_order, category, notes)
VALUES
  ('Coke', 1.00, TRUE, 10, 'Soda', NULL),
  ('Cherry Coke', 1.00, TRUE, 20, 'Soda', NULL),
  ('Sprite', 1.00, TRUE, 30, 'Soda', NULL),
  ('Canada Dry Gingerale', 1.00, TRUE, 40, 'Soda', NULL),
  ('Orange Sunkist', 1.00, TRUE, 50, 'Soda', NULL),
  ('Grape Sunkist', 1.00, TRUE, 60, 'Soda', NULL),
  ('Dr. Pepper', 1.00, TRUE, 70, 'Soda', NULL),
  ('A&W Root Beer', 1.00, TRUE, 80, 'Soda', NULL),
  ('Mt. Dew', 1.00, TRUE, 90, 'Soda', NULL),
  ('Water', 1.00, TRUE, 100, 'Water', NULL),
  ('Sparkling Water', 1.00, TRUE, 110, 'Water', NULL),
  ('La Croix', 1.00, TRUE, 120, 'Water', NULL),
  ('Capri-Sun (2-pack)', 1.00, TRUE, 130, 'Juice', 'Counts as one item')
ON CONFLICT (name) DO NOTHING;

-- ---------- ORDERS ----------
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1000;

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  order_number BIGINT NOT NULL DEFAULT nextval('order_number_seq'),
  customer_name TEXT NOT NULL CHECK (length(trim(customer_name)) > 0),
  total_cost NUMERIC(10,2) NOT NULL CHECK (total_cost >= 0),
  status order_status NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_uq ON orders(order_number);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);

-- Snapshot-friendly order items:
-- store drink_id (FK) AND store name/price snapshot to preserve history if menu changes later
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  drink_id BIGINT REFERENCES drinks(id) ON DELETE SET NULL,
  drink_name TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total NUMERIC(10,2) NOT NULL CHECK (line_total >= 0)
);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS order_items_drink_id_idx ON order_items(drink_id);
