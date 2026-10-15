import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTS } from './src/products.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const wompiBase = process.env.WOMPI_ENV === 'production' ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1';
const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined }) : null;
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireConfig() {
  const missing = ['DATABASE_URL','PUBLIC_URL','WOMPI_PUBLIC_KEY','WOMPI_INTEGRITY_SECRET'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
}
async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, reference VARCHAR(100) UNIQUE NOT NULL,
    customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, phone TEXT NOT NULL,
    city TEXT NOT NULL, address TEXT NOT NULL, notes TEXT, items JSONB NOT NULL,
    amount_cop BIGINT NOT NULL CHECK (amount_cop > 0), payment_status TEXT NOT NULL DEFAULT 'PENDING',
    wompi_transaction_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(payment_status)`);
}
function publicUrl(pathname) { return `${process.env.PUBLIC_URL.replace(/\/$/, '')}${pathname}`; }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function normalizeCustomer(c={}) {
  const customer = { name:String(c.nombre||'').trim(), email:String(c.correo||'').trim().toLowerCase(), phone:String(c.telefono||'').trim(), city:String(c.ciudad||'').trim(), address:String(c.direccion||'').trim(), notes:String(c.notas||'').trim() };
  if (!customer.name || !/^\S+@\S+\.\S+$/.test(customer.email) || !customer.phone || !customer.city || !customer.address || !c.acepto) throw Object.assign(new Error('Completa todos los datos obligatorios y acepta las políticas.'), { status:400 });
  if (Object.values(customer).some(v => v.length > 500)) throw Object.assign(new Error('Uno de los campos es demasiado largo.'), { status:400 });
  return customer;
}
function priceItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) throw Object.assign(new Error('El carrito no es válido.'), {status:400});
  return items.map(item => {
    const product = PRODUCTS.find(p => p.name === item.name);
    if (!product) throw Object.assign(new Error(`Producto no disponible: ${item.name}`), {status:400});
    const sizes = product.category === 'gorras' ? ['ÚNICA'] : ['S','M','L','XL'];
    if (!sizes.includes(item.size)) throw Object.assign(new Error(`Talla inválida para ${product.name}`), {status:400});
    return { name:product.name, category:product.category, size:item.size, quantity:1, unitPrice:product.price, subtotal:product.price };
  });
}
async function getWompiTransaction(id) {
  const key = process.env.WOMPI_PRIVATE_KEY;
  if (!key) throw new Error('WOMPI_PRIVATE_KEY no está configurada');
  const r = await fetch(`${wompiBase}/transactions/${encodeURIComponent(id)}`, { headers:{ Authorization:`Bearer ${key}`, Accept:'application/json' } });
  const d = await r.json();
  if (!r.ok) throw new Error(`Wompi transaction lookup failed (${r.status})`);
  return d.data;
}
async function updateFromWompi(tx) {
  if (!pool || !tx?.reference) return;
  const result = await pool.query('SELECT * FROM orders WHERE reference=$1', [tx.reference]);
  const order = result.rows[0];
  if (!order) return;
  // A payment is accepted only when the server-side Wompi transaction matches this order.
  if (Number(tx.amount_in_cents) !== Number(order.amount_cop) * 100 || tx.currency !== 'COP') return;
  const status = ['APPROVED','DECLINED','VOIDED','ERROR','PENDING'].includes(tx.status) ? tx.status : 'PENDING';
  await pool.query('UPDATE orders SET payment_status=$1, wompi_transaction_id=$2, updated_at=NOW() WHERE reference=$3', [status, tx.id || null, tx.reference]);
}

app.get('/api/health', async (_req,res) => {
  try { if (!pool) throw new Error('DATABASE_URL no configurada'); await pool.query('SELECT 1'); res.json({ok:true, database:'connected', paymentEnvironment:process.env.WOMPI_ENV||'sandbox'}); }
  catch (e) { res.status(503).json({ok:false,error:'Database not ready'}); }
});
app.get('/api/products', (_req,res) => res.json(PRODUCTS));
app.post('/api/orders', async (req,res) => {
  try {
    requireConfig(); if (!pool) return res.status(503).json({error:'Base de datos no configurada.'});
    const customer = normalizeCustomer(req.body.customer);
    const items = priceItems(req.body.items);
    const amount = items.reduce((sum,p)=>sum+p.subtotal,0);
    const reference = `ZEN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await pool.query(`INSERT INTO orders(reference,customer_name,customer_email,phone,city,address,notes,items,amount_cop,payment_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING')`, [reference,customer.name,customer.email,customer.phone,customer.city,customer.address,customer.notes,JSON.stringify(items),amount]);
    const amountInCents = amount * 100;
    const signature = sha256(`${reference}${amountInCents}COP${process.env.WOMPI_INTEGRITY_SECRET}`);
    const checkout = new URL('https://checkout.wompi.co/p/');
    checkout.searchParams.set('public-key', process.env.WOMPI_PUBLIC_KEY);
    checkout.searchParams.set('currency','COP');
    checkout.searchParams.set('amount-in-cents', String(amountInCents));
    checkout.searchParams.set('reference', reference);
    checkout.searchParams.set('signature:integrity', signature);
    checkout.searchParams.set('redirect-url', publicUrl(`/?order=${encodeURIComponent(reference)}`));
    checkout.searchParams.set('customer-data:email', customer.email);
    checkout.searchParams.set('customer-data:full-name', customer.name);
    checkout.searchParams.set('customer-data:phone-number', customer.phone);
    res.status(201).json({order:reference, checkoutUrl:checkout.toString()});
  } catch(e) { console.error('order create error:',e.message); res.status(e.status||500).json({error:e.status?e.message:'No fue posible crear el pedido.'}); }
});
app.get('/api/orders/:reference/status', async (req,res) => {
  try {
    if (!pool) return res.status(503).json({error:'Base de datos no configurada'});
    const result = await pool.query('SELECT reference,payment_status,wompi_transaction_id FROM orders WHERE reference=$1',[req.params.reference]);
    const order = result.rows[0]; if (!order) return res.status(404).json({error:'Pedido no encontrado'});
    const txId = req.query.tx || order.wompi_transaction_id;
    if (txId && process.env.WOMPI_PRIVATE_KEY) {
      try { const tx = await getWompiTransaction(String(txId)); if (tx.reference === order.reference) await updateFromWompi(tx); }
      catch(e) { console.warn('Could not refresh Wompi status:',e.message); }
    }
    const fresh = await pool.query('SELECT reference,payment_status FROM orders WHERE reference=$1',[req.params.reference]);
    res.json({order:fresh.rows[0].reference,payment_status:fresh.rows[0].payment_status});
  } catch(e) { console.error('status error:',e.message); res.status(500).json({error:'No se pudo consultar el pedido.'}); }
});
// Configure this URL in the Wompi merchant dashboard as the transaction.updated webhook.
// Always verify the transaction against Wompi's API; never trust a browser redirect alone.
app.post('/api/wompi/webhook', async (req,res) => {
  try {
    const event = req.body;
    const txId = event?.data?.transaction?.id;
    if (!txId) return res.status(400).json({received:false});
    const tx = await getWompiTransaction(txId);
    await updateFromWompi(tx);
    res.json({received:true});
  } catch(e) { console.error('webhook error:',e.message); res.status(500).json({received:false}); }
});
app.get('*', (_req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
initDb().then(()=>app.listen(PORT,()=>console.log(`ZENITY server listening on ${PORT}`))).catch(e=>{console.error('Database initialization failed:',e);process.exit(1)});
