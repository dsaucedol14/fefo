# FEFO Tarimas

Prototipo académico del sistema de trazabilidad de tarimas y control FEFO de perecederos para almacenes de pymes, especificado en la Actividad 2 (P2) del Seminario de Análisis y Diseño de Sistemas (UNISUR). Es el horizonte de prototipo de la Tabla VII de P2. Sus resultados son los que se usan para contrastar H1a y H1b.

Stack: Node.js 20+, Express 5, EJS, MySQL 8 (RES-05). Funciona en el navegador de teléfonos Android y de computadoras. Escanea con la cámara del teléfono, con un lector de código o con captura manual (RES-03).

## Qué cubre

| Requerimiento | Cómo se cumple | Dónde |
|---|---|---|
| RF-01 ID único y etiqueta QR | Al recibir se genera un ID de 18 dígitos con dígito verificador GS1, compatible con SSCC (CF4). La etiqueta es imprimible. | `src/rutas/recepcion.js`, `src/dominio/ids.js` |
| RF-02 Varios lotes por tarima | `tarima_lote` relaciona tarimas y lotes de muchos a muchos (RN-06). | `src/esquema.js` |
| RF-04 / RN-03 Validar caducidad | Un lote vencido se rechaza. Si sus días restantes son menos que la cobertura más VMR(c), pide autorización de un supervisor. | `src/dominio/reglas.js` |
| RF-06 Colocación por escaneo | La tarima queda «por ubicar» y no se surte hasta que se escanea su posición. Una posición solo admite una tarima. | `src/rutas/tarimas.js` |
| RF-07 Profundidad y bloqueos | Las posiciones de piso guardan fila y profundidad. Cada vista muestra qué tarimas bloquean a cuál. | `src/servicios/inventario.js` |
| RF-08 Reubicación en un flujo | Escanear tarima, escanear destino y confirmar. El origen queda en el historial. | `/mover` |
| RF-09 Localizar | Por lote, SKU, nombre, código GS1 de caja, tarima o posición. | `/localizar` |
| RF-11 Lista de surtido FEFO | RN-01 con desempates, y reservas para que dos pedidos no tomen las mismas cajas (CF2). Si el lote FEFO está bloqueado, lo indica con las tarimas que lo bloquean en vez de saltarlo (C1). | `src/servicios/surtido.js` |
| RF-12 Verificar la salida | Si el lote escaneado no es el propuesto, pide un motivo del catálogo RN-09 y la salida cuenta como excepción, no como conforme. | `src/rutas/pedidos.js` |
| RF-13 Descontar existencias | El saldo baja con una condición en la base: nunca queda negativo (RNF-07). | `src/rutas/pedidos.js` |
| RF-14 / RN-07 Alertas | Nivel según U(c) = mín{VU, VMR + TR + MS} por categoría, más el criterio por rotación. Sin parámetros usa 30 días. | `/alertas`, `/admin/categorias` |
| RF-16 Bloquear caducados | Un lote caducado no se reserva ni sale, y se puede proponer su baja. | `/alertas`, `/surtir` |
| RF-20 (subconjunto) Bitácora | Tarea de evaluación, fecha y hora, usuario, escaneos, resultado y valores anterior y nuevo. Triggers de MySQL impiden editar o borrar la bitácora y los movimientos. | `/admin/bitacora` |
| RNF-08 (acceso básico) | Contraseña de al menos 8 caracteres con bcrypt, bloqueo de 5 minutos al 6.º intento, roles y HTTPS opcional. | `src/rutas/acceso.js` |
| RNF-09 Privacidad | Solo guarda nombre, usuario y rol. Muestra el aviso de privacidad en el primer ingreso. | `/aviso-privacidad` |

También incluye un mapa de ocupación por zona y fila coloreado por nivel de alerta, hojas de etiquetas QR por zona, la caducidad efectiva por ruptura de la cadena de frío y la regla de frío RN-05.

Quedan fuera del prototipo, como marca P2 para la productización:

- RF-03 completo (solo hay lectura mínima GS1)
- RF-05, RF-10, RF-15, RF-17 a RF-19 y RF-22
- La operación sin red (RNF-03)

## Instalación (Windows con Laragon)

1. Enciende MySQL en Laragon. Necesitas Node.js 20 o superior.
2. En la carpeta del proyecto ejecuta `npm install` y luego `copy .env.example .env`. En el `.env` cambia `SESSION_SECRET` y `ADMIN_PASSWORD`.
3. Ejecuta `npm start` o abre `iniciar.bat`. Entra a http://localhost:3200. La base `fefo_tarimas` se crea sola.

**Datos de demostración:** `npm run demo` borra la base y la llena con el caso simulado. Detén el servidor antes de correrlo y vuelve a arrancarlo después.

- El caso es «Distribuidora Sierra Norte», con 232 posiciones, 14 productos y unas 160 tarimas.
- Crea los usuarios `sup01`, `alm01`, `alm02` y `alm03`, todos con contraseña `almacen2026`.

**Cámara del teléfono:** el navegador solo da acceso a la cámara con HTTPS. Con `HTTPS_PORT=3443`, el servidor crea un certificado autofirmado en `certs/`. Desde el teléfono abre `https://IP-de-la-PC:3443` y acepta la advertencia una vez. Si no conecta, permite los puertos 3200 y 3443 en el Firewall de Windows.

**Fecha de operación:** para trabajar con los datos sintéticos del Anexo C, `FECHA_OPERACION=AAAA-MM-DD` fija la fecha con que se calculan caducidades y alertas. En el piloto real debe quedar vacía.

## Evaluación (Sección III.F de P2)

1. El supervisor escribe el código de la tarea en la franja amarilla («Iniciar tarea») antes de que el operador empiece.
2. Todo lo que se registre queda ligado a ese código, en la bitácora y en los movimientos.
3. Al terminar, el supervisor pulsa «Terminar tarea».
4. **Administración → Bitácora** exporta `bitacora.csv` y `movimientos.csv`. El usuario aparece solo como código numérico. `movimientos.csv` trae el lote propuesto, el lote que salió, `conforme_fefo` y el motivo de excepción de cada salida, que son la base de IND-2.

La versión de la aplicación queda en cada renglón de la bitácora. Así se comprueba que la evaluación se hizo con una versión congelada de las reglas.

## Pruebas

- `npm test`: casos límite de las reglas (RN-01, RN-02, RN-03, RN-07, criterio por rotación, ID con verificador, lectura GS1).
- `node scripts/prueba-flujo.js`: recorre la aplicación completa contra el servidor en marcha y la base de demostración.

## Estructura

```
src/
  dominio/     reglas puras: FEFO, umbral U(c), rotación, RN-03, IDs y GS1
  servicios/   consultas de inventario, bloqueos, alertas y lista de surtido
  rutas/       pantallas: recepción, tarimas, localizar, pedidos, alertas, posiciones, admin
  esquema.js   tablas (Anexo D de P2) y triggers de solo inserción
views/         plantillas EJS
public/        estilos y scripts del escáner y la recepción
scripts/       datos de demostración, prueba de flujo e importación del Anexo C
test/          pruebas unitarias
```
