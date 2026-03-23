const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const pool = require("./db");

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      upgradeInsecureRequests: null,
    }
  }
}));
app.use(express.json({ limit: "200kb" }));
app.use(express.static("/app/public"));

// 5 PIN attempts per IP per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in 15 minutes." }
});

// 20 orders per IP per 10 minutes
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many orders submitted. Please wait before trying again." }
});

const ADMIN_PIN = process.env.ADMIN_PIN || "4321";

function requireAdmin(req, res, next) {
  const pin = req.header("X-Admin-Pin");
  if (!pin || pin !== ADMIN_PIN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// -------- AUTH --------
app.post("/api/auth", authLimiter, requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// -------- MENU (public read) --------
// GET /api/menu?all=1  -> includes unavailable too
app.get("/api/menu", async (req, res) => {
  const includeAll = req.query.all === "1";
  try {
    const q = includeAll
      ? `SELECT id, name, price, is_available, sort_order, category, notes FROM drinks ORDER BY sort_order ASC, name ASC`
      : `SELECT id, name, price, is_available, sort_order, category, notes FROM drinks WHERE is_available=true ORDER BY sort_order ASC, name ASC`;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to load menu" });
  }
});

// -------- MENU (admin write) --------
app.post("/api/menu", requireAdmin, async (req, res) => {
  const { name, price, is_available, sort_order, category, notes } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "Bad name" });

  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: "Bad price" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO drinks (name, price, is_available, sort_order, category, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, price, is_available, sort_order, category, notes`,
      [
        name.trim(),
        p,
        typeof is_available === "boolean" ? is_available : true,
        Number.isInteger(sort_order) ? sort_order : 100,
        typeof category === "string" && category.trim() ? category.trim() : "Drinks",
        typeof notes === "string" ? notes : null
      ]
    );
    res.status(201).json({ ok: true, drink: rows[0] });
  } catch {
    res.status(500).json({ error: "Failed to create drink" });
  }
});

app.patch("/api/menu/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad id" });

  const { name, price, is_available, sort_order, category, notes } = req.body || {};

  const sets = [];
  const vals = [];
  let p = 1;

  if (typeof name === "string") { sets.push(`name=$${p++}`); vals.push(name.trim()); }
  if (price !== undefined) { sets.push(`price=$${p++}`); vals.push(Number(price)); }
  if (typeof is_available === "boolean") { sets.push(`is_available=$${p++}`); vals.push(is_available); }
  if (sort_order !== undefined) { sets.push(`sort_order=$${p++}`); vals.push(Number(sort_order)); }
  if (typeof category === "string") { sets.push(`category=$${p++}`); vals.push(category.trim() || "Drinks"); }
  if (notes !== undefined) { sets.push(`notes=$${p++}`); vals.push(notes === "" ? null : notes); }

  if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });

  vals.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE drinks
       SET ${sets.join(", ")}, updated_at=now()
       WHERE id=$${p}
       RETURNING id, name, price, is_available, sort_order, category, notes`,
      vals
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, drink: rows[0] });
  } catch {
    res.status(500).json({ error: "Failed to update drink" });
  }
});

app.delete("/api/menu/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad id" });

  try {
    const r = await pool.query(`DELETE FROM drinks WHERE id=$1`, [id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch {
    res.status(500).json({ error: "Failed to delete drink" });
  }
});

// -------- ORDERS (tamper-proof) --------
// frontend sends: { customerName, items:[{drinkId, quantity}] }
app.post("/api/orders", orderLimiter, async (req, res) => {
  const { customerName, items } = req.body || {};
  if (typeof customerName !== "string" || !customerName.trim()) {
    return res.status(400).json({ error: "Missing customerName" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items must be non-empty" });
  }

  // Validate quantities + ids
  const reqItems = [];
  for (const it of items) {
    const drinkId = Number(it.drinkId);
    const quantity = Number(it.quantity);
    if (!Number.isInteger(drinkId) || drinkId <= 0) return res.status(400).json({ error: "Bad drinkId" });
    if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ error: "Bad quantity" });
    reqItems.push({ drinkId, quantity });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Load current drink data from DB (and ensure available)
    const ids = reqItems.map(x => x.drinkId);
    const drinksRes = await client.query(
      `SELECT id, name, price, is_available
       FROM drinks
       WHERE id = ANY($1::bigint[])`,
      [ids]
    );

    const drinkMap = new Map(drinksRes.rows.map(d => [Number(d.id), d]));
    const finalItems = [];

    for (const r of reqItems) {
      const d = drinkMap.get(r.drinkId);
      if (!d) throw new Error("Drink not found");
      if (!d.is_available) throw new Error("Drink unavailable");

      const unitPrice = Number(d.price);
      const lineTotal = Number((unitPrice * r.quantity).toFixed(2));

      finalItems.push({
        drinkId: r.drinkId,
        drinkName: d.name,
        unitPrice,
        quantity: r.quantity,
        lineTotal
      });
    }

    const totalCost = Number(finalItems.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));

    const orderInsert = await client.query(
      `INSERT INTO orders (customer_name, total_cost)
       VALUES ($1,$2)
       RETURNING id, order_number, status, created_at`,
      [customerName.trim(), totalCost]
    );

    const order = orderInsert.rows[0];

    // bulk insert order_items
    const values = [];
    const params = [];
    let p = 1;
    for (const it of finalItems) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(order.id, it.drinkId, it.drinkName, it.unitPrice, it.quantity, it.lineTotal);
    }

    await client.query(
      `INSERT INTO order_items (order_id, drink_id, drink_name, unit_price, quantity, line_total)
       VALUES ${values.join(", ")}`,
      params
    );

    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      orderId: order.id,
      orderNumber: order.order_number,
      status: order.status,
      createdAt: order.created_at
    });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message || "Order failed" });
  } finally {
    client.release();
  }
});

// Orders + items for staff
app.get("/api/orders", requireAdmin, async (req, res) => {
  const { status } = req.query;
  const allowed = new Set(["new", "in_progress", "fulfilled", "cancelled"]);
  const where = status && allowed.has(status) ? "WHERE o.status = $1" : "";
  const args = where ? [status] : [];

  const q = `
    SELECT
      o.id, o.order_number, o.customer_name, o.total_cost, o.status, o.created_at, o.fulfilled_at,
      COALESCE(
        json_agg(
          json_build_object(
            'drinkId', i.drink_id,
            'name', i.drink_name,
            'unitPrice', i.unit_price,
            'quantity', i.quantity,
            'lineTotal', i.line_total
          )
        ) FILTER (WHERE i.id IS NOT NULL),
        '[]'
      ) AS items
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id
    ${where}
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 200
  `;

  try {
    const { rows } = await pool.query(q, args);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

app.patch("/api/orders/:id/fulfill", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad id" });

  try {
    const r = await pool.query(
      `UPDATE orders SET status='fulfilled', fulfilled_at=now()
       WHERE id=$1
       RETURNING id, order_number, status, fulfilled_at`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Order not found" });
    res.json({ ok: true, order: r.rows[0] });
  } catch {
    res.status(500).json({ error: "Failed to fulfill order" });
  }
});

app.patch("/api/orders/:id/cancel", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad id" });

  try {
    const r = await pool.query(
      `UPDATE orders SET status='cancelled'
       WHERE id=$1 AND status NOT IN ('fulfilled','cancelled')
       RETURNING id, order_number, status`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Order not found or already closed" });
    res.json({ ok: true, order: r.rows[0] });
  } catch {
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

// -------- ORDER MANAGEMENT --------
app.delete("/api/orders", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM orders`);
    console.log(`[flush] Manually deleted ${r.rowCount} orders`);
    res.json({ ok: true, deleted: r.rowCount });
  } catch {
    res.status(500).json({ error: "Failed to flush orders" });
  }
});

// -------- AUTO CLEANUP --------
const RETENTION_HOURS = Math.max(1, Number(process.env.ORDER_RETENTION_HOURS) || 24);

async function purgeOldOrders() {
  try {
    const r = await pool.query(
      `DELETE FROM orders WHERE created_at < now() - ($1 || ' hours')::interval`,
      [RETENTION_HOURS]
    );
    if (r.rowCount > 0) {
      console.log(`[purge] Deleted ${r.rowCount} orders older than ${RETENTION_HOURS}h`);
    }
  } catch (e) {
    console.error("[purge] Failed:", e.message);
  }
}

// Run once at startup then every hour
purgeOldOrders();
setInterval(purgeOldOrders, 60 * 60 * 1000);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on 0.0.0.0:${PORT}`);
  console.log(`Order retention: ${RETENTION_HOURS} hours`);
});
