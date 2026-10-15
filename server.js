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

// Admin access uses HTTP Basic Auth. Configure ADMIN_USER and ADMIN_PASSWORD in Render.
function adminAuth(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) return res.status(503).send('Panel admin sin configurar. Define ADMIN_USER y ADMIN_PASSWORD en Render.');
  const header = req.headers.authorization || '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    let decoded = '';
    try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch {}
    const sep = decoded.indexOf(':');
    if (sep >= 0) {
      const suppliedUser = Buffer.from(decoded.slice(0, sep));
      const suppliedPass = Buffer.from(decoded.slice(sep + 1));
      const expectedUser = Buffer.from(user);
      const expectedPass = Buffer.from(pass);
      const userOk = suppliedUser.length === expectedUser.length && crypto.timingSafeEqual(suppliedUser, expectedUser);
      const passOk = suppliedPass.length === expectedPass.length && crypto.timingSafeEqual(suppliedPass, expectedPass);
      if (userOk && passOk) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="ZENITY Admin", charset="UTF-8"');
  return res.status(401).send('Autenticación requerida.');
}
app.get(['/admin','/admin.html'], adminAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use('/api/admin', adminAuth);
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
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'NUEVO'`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, category TEXT NOT NULL,
    price BIGINT NOT NULL CHECK(price >= 0), stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE, tag TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  for (const p of PRODUCTS) await pool.query(`INSERT INTO products(name,category,price,stock,active) VALUES($1,$2,$3,20,TRUE) ON CONFLICT(name) DO NOTHING`, [p.name,p.category,p.price]);
}
function publicUrl(pathname) { return `${process.env.PUBLIC_URL.replace(/\/$/, '')}${pathname}`; }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function normalizeCustomer(c={}) {
  const customer = { name:String(c.nombre||'').trim(), email:String(c.correo||'').trim().toLowerCase(), phone:String(c.telefono||'').trim(), city:String(c.ciudad||'').trim(), address:String(c.direccion||'').trim(), notes:String(c.notas||'').trim() };
  if (!customer.name || !/^\S+@\S+\.\S+$/.test(customer.email) || !customer.phone || !customer.city || !customer.address || !c.acepto) throw Object.assign(new Error('Completa todos los datos obligatorios y acepta las políticas.'), { status:400 });
  if (Object.values(customer).some(v => v.length > 500)) throw Object.assign(new Error('Uno de los campos es demasiado largo.'), { status:400 });
  return customer;
}
async function priceItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) throw Object.assign(new Error('El carrito no es válido.'), {status:400});
  return Promise.all(items.map(async item => {
    const product = pool ? (await pool.query('SELECT name,category,price,stock,active FROM products WHERE name=$1',[String(item.name||'')])).rows[0] : PRODUCTS.find(p => p.name === item.name);
    if (!product || product.active === false) throw Object.assign(new Error(`Producto no disponible: ${item.name}`), {status:400});
    if (pool && Number(product.stock) < 1) throw Object.assign(new Error(`Producto agotado: ${product.name}`), {status:400});
    const sizes = product.category === 'gorras' ? ['ÚNICA'] : ['S','M','L','XL'];
    if (!sizes.includes(item.size)) throw Object.assign(new Error(`Talla inválida para ${product.name}`), {status:400});
    return { name:product.name, category:product.category, size:item.size, quantity:1, unitPrice:Number(product.price), subtotal:Number(product.price) };
  }));
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
  // Decrease inventory only on the first transition into APPROVED, so repeated webhooks do not subtract twice.
  if (status === 'APPROVED' && order.payment_status !== 'APPROVED') {
    for (const item of (Array.isArray(order.items) ? order.items : [])) {
      await pool.query('UPDATE products SET stock=GREATEST(0,stock-$1),updated_at=NOW() WHERE name=$2', [Math.max(1, Number(item.quantity)||1), item.name]);
    }
  }
  await pool.query('UPDATE orders SET payment_status=$1, wompi_transaction_id=$2, updated_at=NOW() WHERE reference=$3', [status, tx.id || null, tx.reference]);
}

app.get('/api/health', async (_req,res) => {
  try { if (!pool) throw new Error('DATABASE_URL no configurada'); await pool.query('SELECT 1'); res.json({ok:true, database:'connected', paymentEnvironment:process.env.WOMPI_ENV||'sandbox'}); }
  catch (e) { res.status(503).json({ok:false,error:'Database not ready'}); }
});
app.get('/api/products', async (_req,res) => {
  try { if (!pool) return res.json(PRODUCTS.map(p=>({...p,stock:20,active:true}))); const r=await pool.query('SELECT id,name,category,price,stock,active,tag FROM products WHERE active=TRUE ORDER BY id'); res.json(r.rows); }
  catch(e){res.status(500).json({error:'No se pudieron cargar productos'});}
});
app.get('/api/admin/products', async (_req,res) => {
  try { if (!pool) return res.status(503).json({error:'Base de datos no configurada'}); const r=await pool.query('SELECT id,name,category,price,stock,active,tag,created_at,updated_at FROM products ORDER BY id'); res.json(r.rows); }
  catch(e){res.status(500).json({error:'No se pudieron cargar productos'});}
});
app.post('/api/admin/products', async (req,res) => {
  try { const {name,category,price,stock=0,active=true,tag=''}=req.body||{}; const n=String(name||'').trim().toUpperCase(), c=String(category||'').trim().toLowerCase(), pr=Number(price), st=Number(stock);
    if(!n||n.length>120||!['chaquetas','sudaderas','camisetas','pantalones','gorras'].includes(c)||!Number.isSafeInteger(pr)||pr<0||!Number.isInteger(st)||st<0) return res.status(400).json({error:'Revisa nombre, categoría, precio y existencias.'});
    const r=await pool.query('INSERT INTO products(name,category,price,stock,active,tag) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[n,c,pr,st,Boolean(active),String(tag||'').slice(0,40)]); res.status(201).json(r.rows[0]);
  } catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Ya existe un producto con ese nombre.':'No se pudo crear el producto.'});}
});
app.put('/api/admin/products/:id', async (req,res) => {
  try { const {name,category,price,stock,active,tag=''}=req.body||{}; const n=String(name||'').trim().toUpperCase(), c=String(category||'').trim().toLowerCase(), pr=Number(price), st=Number(stock);
    if(!n||n.length>120||!['chaquetas','sudaderas','camisetas','pantalones','gorras'].includes(c)||!Number.isSafeInteger(pr)||pr<0||!Number.isInteger(st)||st<0||typeof active!=='boolean') return res.status(400).json({error:'Revisa los datos del producto.'});
    const r=await pool.query('UPDATE products SET name=$1,category=$2,price=$3,stock=$4,active=$5,tag=$6,updated_at=NOW() WHERE id=$7 RETURNING *',[n,c,pr,st,active,String(tag||'').slice(0,40),req.params.id]); if(!r.rowCount)return res.status(404).json({error:'Producto no encontrado'}); res.json(r.rows[0]);
  } catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Ya existe un producto con ese nombre.':'No se pudo actualizar el producto.'});}
});
app.delete('/api/admin/products/:id', async (req,res) => { try { const r=await pool.query('UPDATE products SET active=FALSE,updated_at=NOW() WHERE id=$1 RETURNING id',[req.params.id]); if(!r.rowCount)return res.status(404).json({error:'Producto no encontrado'}); res.json({ok:true}); } catch(e){res.status(500).json({error:'No se pudo desactivar el producto'});} });
app.patch('/api/admin/orders/:id/fulfillment', async (req,res) => { try { const allowed=['NUEVO','PREPARANDO','ENVIADO','ENTREGADO','CANCELADO']; const status=String(req.body.status||''); const tracking=String(req.body.tracking_number||'').trim().slice(0,120); if(!allowed.includes(status))return res.status(400).json({error:'Estado de envío no válido'}); const r=await pool.query('UPDATE orders SET fulfillment_status=$1,tracking_number=$2,updated_at=NOW() WHERE id=$3 RETURNING id,fulfillment_status,tracking_number',[status,tracking||null,req.params.id]); if(!r.rowCount)return res.status(404).json({error:'Pedido no encontrado'});res.json(r.rows[0]); }catch(e){res.status(500).json({error:'No se pudo actualizar el despacho'});} });
app.get('/api/admin/summary', async (_req,res)=>{try{const r=await pool.query(`SELECT COUNT(*)::int AS orders, COUNT(*) FILTER(WHERE payment_status='APPROVED')::int AS approved, COUNT(*) FILTER(WHERE payment_status='PENDING')::int AS pending, COALESCE(SUM(amount_cop) FILTER(WHERE payment_status='APPROVED'),0)::bigint AS sales, (SELECT COUNT(*)::int FROM products WHERE active=TRUE) AS products, (SELECT COUNT(*)::int FROM products WHERE active=TRUE AND stock<=3) AS low_stock FROM orders`);res.json(r.rows[0]);}catch(e){res.status(500).json({error:'No se pudo cargar el resumen'});}});
app.get('/api/admin/orders', async (_req,res) => {
  try {
    if (!pool) return res.status(503).json({error:'Base de datos no configurada'});
    const result = await pool.query(`SELECT id, reference, customer_name, customer_email, phone, city, address, notes, items, amount_cop, payment_status, fulfillment_status, tracking_number, wompi_transaction_id, created_at, updated_at FROM orders ORDER BY created_at DESC LIMIT 500`);
    res.json(result.rows);
  } catch (e) { console.error('admin orders error:', e.message); res.status(500).json({error:'No se pudieron cargar los pedidos'}); }
});
app.post('/api/orders', async (req,res) => {
  try {
    requireConfig(); if (!pool) return res.status(503).json({error:'Base de datos no configurada.'});
    const customer = normalizeCustomer(req.body.customer);
    const items = await priceItems(req.body.items);
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
