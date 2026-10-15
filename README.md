# ZENITY — tienda con PostgreSQL, Wompi y Render

El frontend conserva el HTML original y sus diseños. Se añade un backend Express, persistencia PostgreSQL y checkout Web de Wompi.

## Importante antes de publicar
- La integración se configura en **sandbox** por defecto. No cambies a producción hasta hacer pruebas completas con las llaves productivas de tu cuenta Wompi.
- El catálogo y los precios se validan en el servidor (no se confía en precios enviados por el navegador).
- Los pedidos quedan `PENDING` hasta que el backend consulte a Wompi. El webhook debe configurarse en el panel de Wompi como `https://TU-DOMINIO.onrender.com/api/wompi/webhook`, evento `transaction.updated`.
- El backend verifica el transaction ID con la API privada de Wompi antes de actualizar estado. Nunca pongas la llave privada ni el secreto de integridad en el HTML.
- El panel inicial autenticado está disponible en `/admin`. Configura `ADMIN_USER` y `ADMIN_PASSWORD` en Render; usa una contraseña larga y única. El panel permite consultar pedidos y ver el catálogo, pero todavía no editar productos ni controlar inventario. Tampoco incluye envío/costos de envío ni correo de confirmación. Completar los datos legales de la marca y revisar políticas antes de vender en producción.

## Ejecutar localmente
1. Instala Node.js 20 o superior y PostgreSQL.
2. Copia `.env.example` a `.env` y completa `DATABASE_URL`, `PUBLIC_URL` (por ejemplo `http://localhost:3000`) y llaves de prueba Wompi (`pub_test_...`, `prv_test_...`, secreto `test_integrity_...`).
3. Ejecuta `npm install` y `npm start`. La tabla `orders` se crea automáticamente.
4. Abre `http://localhost:3000`. Verifica `http://localhost:3000/api/health`.

## Publicar en Render
1. Sube esta carpeta a un repositorio GitHub (no subas `.env` ni llaves).
2. En Render elige **New + → Blueprint** y conecta el repositorio; Render leerá `render.yaml` para crear el servicio web y PostgreSQL. También puedes crear ambos recursos manualmente.
3. En el servicio web configura `PUBLIC_URL=https://NOMBRE-DEL-SERVICIO.onrender.com`, `WOMPI_ENV=sandbox`, `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY` y `WOMPI_INTEGRITY_SECRET` con credenciales sandbox de tu comercio. Render configura `DATABASE_URL` a partir del Blueprint.
4. En Render configura también `ADMIN_USER` (nombre de usuario) y `ADMIN_PASSWORD` (contraseña larga y única) para proteger `/admin`. Despliega y comprueba `https://NOMBRE-DEL-SERVICIO.onrender.com/api/health` (debe responder `ok: true`).
5. Prueba un pedido completo usando métodos de prueba de Wompi. Confirma que el pedido pasa a `APPROVED` en la base de datos y que una compra pendiente/rechazada no se marca como pagada.
6. En el dashboard de Wompi sandbox registra el webhook `https://NOMBRE-DEL-SERVICIO.onrender.com/api/wompi/webhook` para `transaction.updated`.
7. Antes de producción, reemplaza las llaves por las productivas, `WOMPI_ENV=production`, verifica dominio HTTPS, webhook y políticas. No mezcles llaves sandbox y producción.

## Rutas
- `GET /api/health` estado de servicio y base de datos.
- `GET /api/products` catálogo de precios del backend.
- `GET /admin` panel privado con autenticación HTTP Basic.
- `GET /api/admin/orders` pedidos (requiere autenticación).
- `GET /api/admin/products` catálogo para el panel (requiere autenticación).
- `POST /api/orders` valida datos/productos, guarda pedido y devuelve URL de checkout.
- `GET /api/orders/:reference/status?tx=...` consulta estado de pedido; si hay ID de transacción intenta verificarlo con Wompi desde el servidor.
- `POST /api/wompi/webhook` recibe eventos y consulta la transacción en Wompi antes de actualizar el pedido.

## Cómo probar sin hacer cobros reales
Usa exclusivamente las llaves sandbox y los medios/credenciales de prueba indicados en la documentación de Wompi. No introduzcas datos de tarjetas reales en sandbox. La disponibilidad de medios de prueba puede variar según la cuenta.
