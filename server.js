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
app.use(express.json({ limit: '6mb' }));

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
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cop BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    price BIGINT NOT NULL CHECK(price >= 0), stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE, tag TEXT NOT NULL DEFAULT '', front_image TEXT NOT NULL DEFAULT '', back_image TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS front_image TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS back_image TEXT NOT NULL DEFAULT ''`);
  await pool.query(`CREATE TABLE IF NOT EXISTS coupons (id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, discount_type TEXT NOT NULL CHECK(discount_type IN ('PERCENT','FIXED')), discount_value BIGINT NOT NULL CHECK(discount_value > 0), min_amount BIGINT NOT NULL DEFAULT 0, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS store_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  for (const p of PRODUCTS) await pool.query(`INSERT INTO products(name,category,price,stock,active) VALUES($1,$2,$3,20,TRUE) ON CONFLICT(name) DO NOTHING`, [p.name,p.category,p.price]);
}
function safeImage(value='') { const v=String(value||'').trim(); if (!v) return ''; if (v.length>5_000_000) throw Object.assign(new Error('La imagen supera el límite de tamaño. Usa una imagen más pequeña.'),{status:413}); if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/i.test(v)) return v; if (!/^https:\/\//i.test(v) && !/^\/[^/]/.test(v)) throw Object.assign(new Error('Usa una imagen válida, una URL HTTPS o carga un archivo desde tu equipo.'),{status:400}); return v; }
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
    const product = pool ? (await pool.query('SELECT id,name,category,price,stock,active FROM products WHERE name=$1',[String(item.name||'')])).rows[0] : PRODUCTS.find(p => p.name === item.name);
    if (!product || product.active === false) throw Object.assign(new Error(`Producto no disponible: ${item.name}`), {status:400});
    if (pool && Number(product.stock) < 1) throw Object.assign(new Error(`Producto agotado: ${product.name}`), {status:400});
    const sizes = product.category === 'gorras' ? ['ÚNICA'] : ['S','M','L','XL'];
    if (!sizes.includes(item.size)) throw Object.assign(new Error(`Talla inválida para ${product.name}`), {status:400});
    return { product_id:product.id ? Number(product.id) : null, name:product.name, category:product.category, size:item.size, quantity:1, unitPrice:Number(product.price), subtotal:Number(product.price) };
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM orders WHERE reference=$1 FOR UPDATE', [tx.reference]);
    const order = result.rows[0];
    if (!order) { await client.query('COMMIT'); return; }
    // Only accept a transaction whose amount/currency match the server-created order.
    if (Number(tx.amount_in_cents) !== Number(order.amount_cop) * 100 || tx.currency !== 'COP') { await client.query('ROLLBACK'); return; }
    const status = ['APPROVED','DECLINED','VOIDED','ERROR','PENDING'].includes(tx.status) ? tx.status : 'PENDING';
    // Row lock plus status transition makes duplicate/concurrent webhooks idempotent.
    if (status === 'APPROVED' && order.payment_status !== 'APPROVED') {
      for (const item of (Array.isArray(order.items) ? order.items : [])) {
        if (item.product_id) await client.query('UPDATE products SET stock=GREATEST(0,stock-$1),updated_at=NOW() WHERE id=$2', [Math.max(1, Number(item.quantity)||1), item.product_id]);
        else await client.query('UPDATE products SET stock=GREATEST(0,stock-$1),updated_at=NOW() WHERE name=$2', [Math.max(1, Number(item.quantity)||1), item.name]);
      }
      if (order.coupon_code) await client.query('UPDATE coupons SET uses=uses+1 WHERE code=$1', [order.coupon_code]);
    }
    await client.query('UPDATE orders SET payment_status=$1, wompi_transaction_id=$2, updated_at=NOW() WHERE reference=$3', [status, tx.id || null, tx.reference]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally { client.release(); }
}

app.get('/api/health', async (_req,res) => {
  try { if (!pool) throw new Error('DATABASE_URL no configurada'); await pool.query('SELECT 1'); res.json({ok:true, database:'connected', paymentEnvironment:process.env.WOMPI_ENV||'sandbox'}); }
  catch (e) { res.status(503).json({ok:false,error:'Database not ready'}); }
});
app.get('/api/products', async (_req,res) => {
  try { if (!pool) return res.json(PRODUCTS.map(p=>({...p,stock:20,active:true}))); const r=await pool.query('SELECT id,name,category,description,price,stock,active,tag,front_image,back_image FROM products WHERE active=TRUE ORDER BY id'); res.json(r.rows); }
  catch(e){res.status(500).json({error:'No se pudieron cargar productos'});}
});
app.get('/api/admin/products', async (_req,res) => {
  try { if (!pool) return res.status(503).json({error:'Base de datos no configurada'}); const r=await pool.query('SELECT id,name,category,description,price,stock,active,tag,front_image,back_image,created_at,updated_at FROM products ORDER BY id'); res.json(r.rows); }
  catch(e){res.status(500).json({error:'No se pudieron cargar productos'});}
});
app.post('/api/admin/products', async (req,res) => {
  try { const {name,category,price,stock=0,active=true,tag='',description='',front_image='',back_image=''}=req.body||{}; const n=String(name||'').trim().toUpperCase(), c=String(category||'').trim().toLowerCase(), pr=Number(price), st=Number(stock);
    if(!n||n.length>120||!['chaquetas','sudaderas','camisetas','pantalones','gorras'].includes(c)||!Number.isSafeInteger(pr)||pr<0||!Number.isInteger(st)||st<0) return res.status(400).json({error:'Revisa nombre, categoría, precio y existencias.'});
    const r=await pool.query('INSERT INTO products(name,category,price,stock,active,tag,description,front_image,back_image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[n,c,pr,st,Boolean(active),String(tag||'').slice(0,40),String(description||'').slice(0,1000),safeImage(front_image),safeImage(back_image)]); res.status(201).json(r.rows[0]);
  } catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Ya existe un producto con ese nombre.':'No se pudo crear el producto.'});}
});
app.put('/api/admin/products/:id', async (req,res) => {
  try { const {name,category,price,stock,active,tag='',description='',front_image='',back_image=''}=req.body||{}; const n=String(name||'').trim().toUpperCase(), c=String(category||'').trim().toLowerCase(), pr=Number(price), st=Number(stock);
    if(!n||n.length>120||!['chaquetas','sudaderas','camisetas','pantalones','gorras'].includes(c)||!Number.isSafeInteger(pr)||pr<0||!Number.isInteger(st)||st<0||typeof active!=='boolean') return res.status(400).json({error:'Revisa los datos del producto.'});
    const r=await pool.query('UPDATE products SET name=$1,category=$2,price=$3,stock=$4,active=$5,tag=$6,description=$7,front_image=$8,back_image=$9,updated_at=NOW() WHERE id=$10 RETURNING *',[n,c,pr,st,active,String(tag||'').slice(0,40),String(description||'').slice(0,1000),safeImage(front_image),safeImage(back_image),req.params.id]); if(!r.rowCount)return res.status(404).json({error:'Producto no encontrado'}); res.json(r.rows[0]);
  } catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Ya existe un producto con ese nombre.':'No se pudo actualizar el producto.'});}
});
app.delete('/api/admin/products/:id', async (req,res) => { try { const r=await pool.query('UPDATE products SET active=FALSE,updated_at=NOW() WHERE id=$1 RETURNING id',[req.params.id]); if(!r.rowCount)return res.status(404).json({error:'Producto no encontrado'}); res.json({ok:true}); } catch(e){res.status(500).json({error:'No se pudo desactivar el producto'});} });
app.patch('/api/admin/orders/:id/fulfillment', async (req,res) => {
  try {
    if (!pool) return res.status(503).json({error:'Base de datos no configurada'});
    const id = String(req.params.id || '');
    if (!/^\d+$/.test(id)) return res.status(400).json({error:'Identificador de pedido no válido'});
    const allowed=['NUEVO','PREPARANDO','ENVIADO','ENTREGADO','CANCELADO'];
    const status=String(req.body?.status||'');
    const tracking=String(req.body?.tracking_number||'').trim().slice(0,120);
    if(!allowed.includes(status)) return res.status(400).json({error:'Estado de despacho no válido'});
    const r=await pool.query('UPDATE orders SET fulfillment_status=$1,tracking_number=$2,updated_at=NOW() WHERE id=$3 RETURNING id,reference,fulfillment_status,tracking_number,updated_at',[status,tracking||null,id]);
    if(!r.rowCount) return res.status(404).json({error:'No se encontró el pedido para guardar el despacho'});
    res.json({ok:true,...r.rows[0]});
  } catch(e) {
    console.error('save fulfillment error:', e.message);
    res.status(500).json({error:'No se pudo guardar el despacho en la base de datos'});
  }
});
app.delete('/api/admin/orders/:id', async (req,res) => {
  try {
    if (!pool) return res.status(503).json({error:'Base de datos no configurada'});
    const id=String(req.params.id||'');
    if (!/^\d+$/.test(id)) return res.status(400).json({error:'Identificador de pedido no válido'});
    const r=await pool.query('DELETE FROM orders WHERE id=$1 RETURNING id,reference',[id]);
    if (!r.rowCount) return res.status(404).json({error:'No se encontró el pedido'});
    res.json({ok:true,deleted:r.rows[0]});
  } catch(e) {
    console.error('delete order error:',e.message);
    res.status(500).json({error:'No se pudo eliminar el pedido'});
  }
});
app.get('/api/admin/coupons', async (_req,res)=>{try{const r=await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');res.json(r.rows)}catch(e){res.status(500).json({error:'No se pudieron cargar promociones'})}});
app.post('/api/admin/coupons', async (req,res)=>{try{const b=req.body||{},code=String(b.code||'').trim().toUpperCase(),type=String(b.discount_type||'PERCENT'),value=Number(b.discount_value),min=Number(b.min_amount||0),max=b.max_uses===''||b.max_uses==null?null:Number(b.max_uses);if(!/^[A-Z0-9_-]{3,32}$/.test(code)||!['PERCENT','FIXED'].includes(type)||!Number.isSafeInteger(value)||value<=0||(type==='PERCENT'&&value>100)||!Number.isSafeInteger(min)||min<0||(max!==null&&(!Number.isInteger(max)||max<1)))return res.status(400).json({error:'Revisa código, tipo de descuento, valor y límites.'});const r=await pool.query('INSERT INTO coupons(code,discount_type,discount_value,min_amount,max_uses,active,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[code,type,value,min,max,b.active!==false,b.starts_at||null,b.ends_at||null]);res.status(201).json(r.rows[0])}catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Ese código ya existe.':'No se pudo crear el cupón.'})}});
app.put('/api/admin/coupons/:id', async (req,res)=>{try{const b=req.body||{},code=String(b.code||'').trim().toUpperCase(),type=String(b.discount_type||'PERCENT'),value=Number(b.discount_value),min=Number(b.min_amount||0),max=b.max_uses===''||b.max_uses==null?null:Number(b.max_uses);if(!/^[A-Z0-9_-]{3,32}$/.test(code)||!['PERCENT','FIXED'].includes(type)||!Number.isSafeInteger(value)||value<=0||(type==='PERCENT'&&value>100)||!Number.isSafeInteger(min)||min<0||(max!==null&&(!Number.isInteger(max)||max<1)))return res.status(400).json({error:'Revisa los datos del cupón.'});const r=await pool.query('UPDATE coupons SET code=$1,discount_type=$2,discount_value=$3,min_amount=$4,max_uses=$5,active=$6,starts_at=$7,ends_at=$8 WHERE id=$9 RETURNING *',[code,type,value,min,max,b.active!==false,b.starts_at||null,b.ends_at||null,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Cupón no encontrado'});res.json(r.rows[0])}catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Ese código ya existe.':'No se pudo actualizar el cupón.'})}});
app.delete('/api/admin/coupons/:id', async (req,res)=>{try{const r=await pool.query('UPDATE coupons SET active=FALSE WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Cupón no encontrado'});res.json({ok:true})}catch(e){res.status(500).json({error:'No se pudo desactivar el cupón.'})}});
app.get('/api/admin/settings',async(_req,res)=>{try{const r=await pool.query('SELECT key,value FROM store_settings ORDER BY key');res.json(Object.fromEntries(r.rows.map(x=>[x.key,x.value])))}catch(e){res.status(500).json({error:'No se pudo cargar la configuración'})}});
app.put('/api/admin/settings',async(req,res)=>{try{const allowed=['store_name','contact_email','whatsapp','instagram','shipping_note','low_stock_threshold'];const entries=Object.entries(req.body||{}).filter(([k])=>allowed.includes(k));for(const [key,value] of entries){const v=String(value??'').slice(0,1000);await pool.query('INSERT INTO store_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',[key,JSON.stringify(v)])}res.json({ok:true})}catch(e){res.status(500).json({error:'No se pudo guardar la configuración'})}});
app.get('/api/storefront/settings',async(_req,res)=>{try{if(!pool)return res.json({});const r=await pool.query("SELECT key,value FROM store_settings WHERE key IN ('store_name','contact_email','whatsapp','instagram','shipping_note')");res.json(Object.fromEntries(r.rows.map(x=>[x.key,x.value])))}catch(e){res.json({})}});

app.get('/api/admin/summary', async (_req,res)=>{try{const sr=await pool.query("SELECT value #>> '{}' AS threshold FROM store_settings WHERE key='low_stock_threshold'");const threshold=Math.max(0,Math.min(100000,Number(sr.rows[0]?.threshold??3)||0));const r=await pool.query(`SELECT COUNT(*)::int AS orders, COUNT(*) FILTER(WHERE payment_status='APPROVED')::int AS approved, COUNT(*) FILTER(WHERE payment_status='PENDING')::int AS pending, COALESCE(SUM(amount_cop) FILTER(WHERE payment_status='APPROVED'),0)::bigint AS sales, (SELECT COUNT(*)::int FROM products WHERE active=TRUE) AS products, (SELECT COUNT(*)::int FROM products WHERE active=TRUE AND stock<=$1) AS low_stock FROM orders`,[threshold]);res.json({...r.rows[0],low_stock_threshold:threshold});}catch(e){res.status(500).json({error:'No se pudo cargar el resumen'});}});
app.get('/api/admin/orders', async (_req,res) => {
  try {
    if (!pool) return res.status(503).json({error:'Base de datos no configurada'});
    const result = await pool.query(`SELECT id, reference, customer_name, customer_email, phone, city, address, notes, items, amount_cop, discount_cop, coupon_code, payment_status, fulfillment_status, tracking_number, wompi_transaction_id, created_at, updated_at FROM orders ORDER BY created_at DESC LIMIT 500`);
    res.json(result.rows);
  } catch (e) { console.error('admin orders error:', e.message); res.status(500).json({error:'No se pudieron cargar los pedidos'}); }
});
async function resolveCoupon(code, subtotal) {
  const clean=String(code||'').trim().toUpperCase(); if(!clean) return {code:null,discount:0};
  if(!pool) throw Object.assign(new Error('Los cupones requieren base de datos.'),{status:503});
  const r=await pool.query('SELECT * FROM coupons WHERE code=$1 AND active=TRUE',[clean]); const c=r.rows[0]; const now=Date.now();
  if(!c || (c.starts_at && new Date(c.starts_at).getTime()>now) || (c.ends_at && new Date(c.ends_at).getTime()<now) || (c.max_uses!==null && Number(c.uses)>=Number(c.max_uses)) || subtotal<Number(c.min_amount)) throw Object.assign(new Error('El cupón no es válido, está vencido o no cumple las condiciones.'),{status:400});
  const discount=Math.min(subtotal, c.discount_type==='PERCENT'?Math.floor(subtotal*Number(c.discount_value)/100):Number(c.discount_value));
  if(c.discount_type==='PERCENT' && Number(c.discount_value)>100) throw Object.assign(new Error('Configuración de cupón inválida.'),{status:400});
  return {code:c.code,discount};
}
app.post('/api/coupons/validate', async (req,res)=>{try{const items=await priceItems(req.body.items);const subtotal=items.reduce((s,p)=>s+p.subtotal,0);const c=await resolveCoupon(req.body.code,subtotal);res.json({valid:true,code:c.code,discount_cop:c.discount,total_cop:subtotal-c.discount});}catch(e){res.status(e.status||500).json({error:e.status?e.message:'No se pudo validar el cupón.'});}});

app.post('/api/orders', async (req,res) => {
  try {
    requireConfig(); if (!pool) return res.status(503).json({error:'Base de datos no configurada.'});
    const customer = normalizeCustomer(req.body.customer);
    const items = await priceItems(req.body.items);
    const subtotal = items.reduce((sum,p)=>sum+p.subtotal,0);
    const coupon = await resolveCoupon(req.body.couponCode, subtotal);
    const amount = subtotal - coupon.discount;
    if (amount <= 0) throw Object.assign(new Error('El total del pedido debe ser mayor que cero.'),{status:400});
    const reference = `ZEN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await pool.query(`INSERT INTO orders(reference,customer_name,customer_email,phone,city,address,notes,items,amount_cop,discount_cop,coupon_code,payment_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')`, [reference,customer.name,customer.email,customer.phone,customer.city,customer.address,customer.notes,JSON.stringify(items),amount,coupon.discount,coupon.code]);
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
