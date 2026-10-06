# ZENITY · Tienda con PostgreSQL + Wompi

## Qué hace
1. El cliente llena sus datos y pulsa **Confirmar y pagar**.
2. El servidor guarda el pedido en PostgreSQL con `payment_status = PENDING`, calcula el total con los precios del servidor y firma el pago.
3. El cliente es enviado a **Wompi** (tarjetas, PSE, Nequi, Bancolombia…).
4. Wompi avisa al servidor (webhook) y el pedido pasa a `APPROVED`, `DECLINED`, `VOIDED` o `ERROR`. Al volver a la tienda el cliente ve el resultado.
5. Ves todo en `/admin.html` (PAGADO / PENDIENTE / RECHAZADO).

## Puesta en marcha
```bash
npm install
cp .env.example .env        # completa tus datos
createdb zenity             # o crea la base en Neon / Supabase / Railway / Render
npm run db                  # crea las tablas (schema.sql)
npm start                   # http://localhost:3000
```

## Wompi
1. Crea tu cuenta en https://comercios.wompi.co y ve a **Desarrolladores**.
2. Copia las llaves de **pruebas**: pública, secreto de integridad y secreto de eventos → `.env`.
3. En esa misma sección configura la **URL de eventos**: `https://TU-DOMINIO/api/wompi/webhook` (en local usa ngrok).
4. Prueba con las tarjetas de prueba de Wompi. Cuando todo funcione, cambia a llaves de producción y `WOMPI_ENV=production`.

## Importante
- Los precios viven en `CATALOG` de `server.js` y deben coincidir con los nombres de `public/index.html`.
- `BASE_URL` debe ser la URL pública del sitio (Wompi redirige ahí al terminar).
- Sube a un hosting con Node (Render, Railway, Fly…) con HTTPS. Nunca expongas `.env`.
- El panel `/admin.html` pide `ADMIN_TOKEN`; usa una clave larga.
- Consulta tu situación tributaria y de facturación con un contador.
