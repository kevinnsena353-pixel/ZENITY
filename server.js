require('dotenv').config();
const express = require('express'), crypto = require('crypto'), path = require('path'), { Pool } = require('pg');
const E = process.env;
const WAPI = E.WOMPI_ENV === 'production' ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1';
const BASE = (E.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const pool = new Pool({ connectionString: E.DATABASE_URL, ssl: E.PGSSL === 'true' ? { rejectUnauthorized: false } : false });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Precios SIEMPRE se calculan aquí (nunca confiar en el navegador). Mantén los nombres igual que en public/index.html
const CATALOG = {
  'CHAQUETA REAPER': 259000, 'CHAQUETA BOMBER RED': 249000, 'SUDADERA APEX': 169000, 'SUDADERA NOIR': 169000,
  'CAMISETA ORBIT': 89000, 'CAMISETA RED SUN': 89000, 'CAMISETA ZERO': 85000, 'PANTALÓN CARGO': 149000,
  'JOGGER VOLT': 129000, 'GORRA SPIKE': 69000, 'GORRA CROSS': 69000
};
const SIZES = ['S', 'M', 'L', 'XL', 'ÚNICA'];
const str = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);

const app = express();
app.use(express.json({ limit: '100kb' }));

// Aplica el resultado de una transacción de Wompi a la orden (idempotente y validando el monto)
async function applyTx(tx) {
  const { rows } = await pool.query('SELECT id,total_cop,payment_status FROM orders WHERE id=$1', [tx.reference]);
  const o = rows[0]; if (!o) return null;
  await pool.query('INSERT INTO payment_events(order_id,wompi_transaction_id,status,payload) VALUES($1,$2,$3,$4)',
    [o.id, tx.id, tx.status, tx]);
  if (tx.amount_in_cents !== o.total_cop * 100) { console.warn('Monto no coincide', o.id); return o.payment_status; }
  if (o.payment_status === 'APPROVED') return 'APPROVED';            // un pago aprobado no se revierte por eventos tardíos
  const r = await pool.query(
    `UPDATE orders SET payment_status=$1, wompi_transaction_id=$2, payment_method=$3, updated_at=now(),
     paid_at = CASE WHEN $1='APPROVED' THEN now() ELSE paid_at END WHERE id=$4 RETURNING payment_status`,
    [tx.status, tx.id, tx.payment_method_type || null, o.id]);
  return r.rows[0].payment_status;
}

// 1) Crear pedido (queda PENDING) y devolver la URL de pago de Wompi
app.post('/api/orders', async (req, res) => {
  try {
    const c = req.body.customer || {}, items = Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : [];
    const cu = { name: str(c.nombre, 120), email: str(c.correo, 120), phone: str(c.telefono, 30).replace(/\D/g, ''),
      city: str(c.ciudad, 80), address: str(c.direccion, 200), notes: str(c.notas, 500) };
    if (!cu.name || !/^\S+@\S+\.\S+$/.test(cu.email) || cu.phone.length < 7 || !cu.city || !cu.address || !items.length)
      return res.status(400).json({ error: 'Datos incompletos' });
    const lines = items.map(i => ({ name: str(i.name), size: SIZES.includes(i.size) ? i.size : 'M', price: CATALOG[str(i.name)] }));
    if (lines.some(l => !l.price)) return res.status(400).json({ error: 'Producto no válido' });
    const total = lines.reduce((a, l) => a + l.price, 0), id = 'ZN-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
    await pool.query(`INSERT INTO orders(id,customer_name,email,phone,city,address,notes,items,total_cop)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, cu.name, cu.email, cu.phone, cu.city, cu.address, cu.notes, JSON.stringify(lines), total]);
    const cents = total * 100, u = new URL('https://checkout.wompi.co/p/');
    const p = { 'public-key': E.WOMPI_PUBLIC_KEY, currency: 'COP', 'amount-in-cents': cents, reference: id,
      'signature:integrity': sha(`${id}${cents}COP${E.WOMPI_INTEGRITY_SECRET}`), 'redirect-url': `${BASE}/?order=${id}`,
      'customer-data:email': cu.email, 'customer-data:full-name': cu.name, 'customer-data:phone-number': cu.phone.slice(-10), 'customer-data:phone-number-prefix': '+57' };
    Object.entries(p).forEach(([k, v]) => u.searchParams.set(k, v));
    res.json({ orderId: id, checkoutUrl: u.toString() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno' }); }
});

// 2) Estado del pedido al volver de Wompi (consulta a Wompi con el id que trae la redirección)
app.get('/api/orders/:id/status', async (req, res) => {
  try {
    if (req.query.tx) {
      const r = await fetch(`${WAPI}/transactions/${encodeURIComponent(req.query.tx)}`);
      const tx = (await r.json()).data;
      if (tx && tx.reference === req.params.id) await applyTx(tx);
    }
    const { rows } = await pool.query('SELECT payment_status FROM orders WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No existe' });
    res.json({ payment_status: rows[0].payment_status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno' }); }
});

// 3) Webhook de Wompi (fuente de verdad del pago). URL de eventos: BASE_URL/api/wompi/webhook
app.post('/api/wompi/webhook', async (req, res) => {
  try {
    const ev = req.body, s = ev && ev.signature;
    if (!s || !Array.isArray(s.properties) || !ev.timestamp) return res.sendStatus(400);
    const vals = s.properties.map(p => p.split('.').reduce((o, k) => (o == null ? o : o[k]), ev.data));
    if (!safeEq(sha(vals.join('') + ev.timestamp + E.WOMPI_EVENTS_SECRET), String(s.checksum))) return res.sendStatus(401);
    if (ev.event === 'transaction.updated' && ev.data && ev.data.transaction) await applyTx(ev.data.transaction);
    res.sendStatus(200);
  } catch (e) { console.error(e); res.sendStatus(500); }
});

// 4) Panel de pedidos (requiere cabecera x-admin-token)
app.get('/api/admin/orders', async (req, res) => {
  if (!E.ADMIN_TOKEN || !safeEq(String(req.get('x-admin-token') || ''), E.ADMIN_TOKEN)) return res.sendStatus(401);
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500');
  res.json(rows);
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(E.PORT || 3000, () => console.log('ZENITY listo en ' + BASE));
