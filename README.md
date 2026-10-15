# ZENITY — tienda con PostgreSQL, Wompi y Render

El frontend conserva el HTML original y sus diseños. Se añade un backend Express, persistencia PostgreSQL y checkout Web de Wompi.

## Importante antes de publicar
- La integración se configura en **sandbox** por defecto. No cambies a producción hasta hacer pruebas completas con las llaves productivas de tu cuenta Wompi.
- El catálogo y los precios se validan en el servidor (no se confía en precios enviados por el navegador).
- Los pedidos quedan `PENDING` hasta que el backend consulte a Wompi. El webhook debe configurarse en el panel de Wompi como `https://TU-DOMINIO.onrender.com/api/wompi/webhook`, evento `transaction.updated`.
- El backend verifica el transaction ID con la API privada de Wompi antes de actualizar estado. Nunca pongas la llave privada ni el secreto de integridad en el HTML.
- El panel autenticado está disponible en `/admin`. Configura `ADMIN_USER` y `ADMIN_PASSWORD` en Render; usa una contraseña larga y única. Desde el panel se gestionan productos, precios, existencias, imágenes por URL, pedidos, despachos, clientes, cupones y algunos ajustes de tienda. No incluye carga directa de archivos de imagen, integración automática con transportadoras ni reembolsos de Wompi.

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
- `GET/POST/PUT/DELETE /api/admin/products` catálogo e inventario (requiere autenticación; el borrado es desactivación).
- `GET/POST/PUT/DELETE /api/admin/coupons` gestión de promociones (requiere autenticación).
- `GET/PUT /api/admin/settings` ajustes de tienda (requiere autenticación).
- `POST /api/coupons/validate` valida un cupón antes del pago.
- `POST /api/orders` valida datos/productos, guarda pedido y devuelve URL de checkout.
- `GET /api/orders/:reference/status?tx=...` consulta estado de pedido; si hay ID de transacción intenta verificarlo con Wompi desde el servidor.
- `POST /api/wompi/webhook` recibe eventos y consulta la transacción en Wompi antes de actualizar el pedido.

## Cómo probar sin hacer cobros reales
Usa exclusivamente las llaves sandbox y los medios/credenciales de prueba indicados en la documentación de Wompi. No introduzcas datos de tarjetas reales en sandbox. La disponibilidad de medios de prueba puede variar según la cuenta.


## Funciones del panel de administración ampliado

Entra a `/admin` con `ADMIN_USER` y `ADMIN_PASSWORD` configurados en Render. El panel incluye resumen de ventas/pedidos, gestión de catálogo (crear, editar, ocultar/activar), precios, categoría, etiqueta y existencias; alertas de stock bajo; filtros de pedidos por pago y despacho; actualización de estado logístico y guía; vista de clientes calculada desde los pedidos; y exportación CSV de pedidos.

Las tablas `products`, `coupons` y `store_settings` se crean automáticamente y se inicializan con los productos del catálogo que aún no existan, con 20 unidades iniciales por producto. **Antes de operar la tienda, revisa y corrige esas existencias para que coincidan con tu inventario real.** Los productos nuevos o cambios de precio/stock hechos en el panel se reflejan en el catálogo público y el servidor usa el precio guardado en la base de datos al crear el pedido. El stock se descuenta cuando Wompi confirma por primera vez el pago aprobado.

Las imágenes de producto se agregan mediante URL HTTPS (no mediante carga de archivos). Los códigos promocionales pueden ser porcentuales o de valor fijo, con mínimo de compra, fechas y límite de usos. La configuración de tienda se guarda en PostgreSQL; los campos de contacto son datos de configuración y deben verificarse en el diseño público antes de anunciarse. No hay integración automática con transportadoras ni devoluciones/reembolsos de Wompi.
