# FEFO Tarimas · prototipo de P3

Prototipo del sistema de trazabilidad de tarimas y control FEFO de perecederos para almacenes de pymes, construido según el diseño de la **Actividad 3 (P3)** del Seminario de Análisis y Diseño de Sistemas (UNISUR). Implementa la alternativa A2 de P3: aplicación web progresiva con cola local de escaneos, servidor modular en capas y PostgreSQL 16 con las reglas críticas impuestas en la base.

| Capa | Tecnología (P3, Tabla XIII) |
|---|---|
| Cliente | PWA en TypeScript con Vite; Service Worker con Workbox; cola en IndexedDB (`idb`); escaneo con BarcodeDetector y ZXing de respaldo |
| Servidor | Node.js 22 LTS, TypeScript, Fastify con validación por esquema JSON, node-postgres con SQL parametrizado |
| Base de datos | PostgreSQL 16: `bd/01_esquema.sql` y `bd/02_catalogo.sql` de P3 sin cambios, más `bd/06_extension_prototipo.sql` (ADR-010) |
| Despliegue | Docker Compose: PostgreSQL, API y Caddy con HTTPS de autoridad interna; respaldo con `pg_dump` |
| Pruebas | Vitest (unitarias e integración contra PostgreSQL), guion SQL de P3 (PI-01 a PI-27), Playwright (extremo a extremo), prueba de rendimiento PR-01 |

Los datos de comportamiento del almacén son simulados [S]. Sirven para verificar el sistema, no para contrastar H1a ni H1b.

## Qué cubre del prototipo (P3, Tabla II)

| Requerimiento | Implementación | Verificación |
|---|---|---|
| RF-01, 02, 04 · RN-03 | Recepción con escaneo GS1 o captura manual; ID de 18 dígitos con verificador; varios lotes por tarima; vida remanente con autorización del supervisor | `api.test.ts` (PE-01), PU-10 |
| RF-05 (parcial) · RN-05 | Sugerencia de posición: frío solo en C; en piso, la caducidad lejana va al fondo. La base impone RN-05, incluida la cámara reservada a frío y la prohibición de mezclar | PE-02, PI-02 a PI-04 |
| RF-06, RF-08 | Ubicar y reubicar con 2 escaneos y 1 confirmación, como movimientos que aplica `tg_aplica_movimiento` | PE-02, PE-04, Playwright |
| RF-07, RF-09 | Búsqueda por lote, SKU, nombre, código GS1, tarima o posición, con profundidad y tarimas que bloquean (`v_bloqueo`) | PE-05, PR-01 |
| RF-11 · C1 · CF2 | Lista de surtido del motor FEFO (función pura, ADR-005) con reservas, bloqueo y alternativa accesible (Fig. 11a) | PU-01 a PU-04, PE-07 |
| RF-12, RF-13 · RN-09 | Verificación del lote escaneado; si no es FEFO, la base exige un motivo del catálogo (Fig. 11b); el saldo nunca queda negativo | PE-07, PI-05 a PI-09 |
| RF-14 · RN-07 | Alertas por U(c) de cada categoría y riesgo por rotación (`v_alerta`); umbrales editables sin código | PU-06, PU-07 |
| RF-16 · RN-02 | La base rechaza la salida de lotes caducados; propuesta de baja pendiente | PE-07, PI-10 |
| RF-20, RF-21 (básico) | Movimientos, bitácora y eventos de solo inserción; roles almacenista, supervisor y administración | PI-11, PI-12, PI-26 |
| RNF-01 | Búsqueda p95 de 81 ms con 5 000 lotes, a través de la API completa | `npm run rendimiento` |
| RNF-03 (nivel 1) | Cola en IndexedDB con `id_mov` (UUID) y hora del dispositivo; sincronización idempotente; rechazos a revisión del supervisor (Fig. 11c) | `cola.test.ts` (30 movimientos, 0 perdidos, 0 duplicados), Playwright en modo avión |
| RNF-05 | Controles de 56 px de alto como mínimo, contraste de 4.5:1 o más y etiquetas asociadas a sus campos | Capturas de Playwright |
| RNF-07 | Restricciones y disparadores de P3; vistas I8 e I9 vacías | Carga del caso simulado |
| RNF-08 (básico) | bcrypt, bloqueo al 5.º intento, cookie HttpOnly + Secure + SameSite=Strict, HTTPS con Caddy | `api.test.ts` |
| RNF-09 | Solo nombre, usuario y rol; aviso de privacidad en el primer ingreso | `api.test.ts` |
| OD7 | Cada movimiento guarda usuario, dispositivo, hora del dispositivo y del servidor, tarea, escaneos y lote propuesto; exportes CSV | `api.test.ts` |

Lo que P3 asigna a la productización (RF-03 completo, RF-10, RF-17 a RF-19, RNF-03 nivel 2, RF-22) tiene tablas en el modelo, pero sus pantallas no se construyeron. RF-15 queda condicionado, como indica P3.

## Puesta en marcha para desarrollo

Requisitos: Node.js 22 o superior, Docker y Python 3.8 o superior (para `sim.py` de P2).

```sh
npm install
docker run -d --name fefo-pg -e POSTGRES_PASSWORD=fefo-dev -e TZ=America/Mexico_City -p 5433:5432 postgres:16
npm run bd:preparar                    # base «fefo»: 01 + 02 + 06; usuarios con contraseña almacen2026
python <ruta>/programas_P2_v2/sim.py --salida datos/sim_v2
npm run bd:cargar-sim                  # caso simulado: 4 428 movimientos aplicados por la base
npm run build && COOKIE_SEGURA=0 npm start   # http://localhost:3000
```

### Desarrollo en esta Mac (Intel, sin Docker)

Homebrew dejó de soportar Mac Intel, así que en esta máquina PostgreSQL 16 corre con
[Postgres.app](https://postgresapp.com/) en lugar de Docker. Ya está instalado en `/Applications/Postgres.app`,
con un cluster dedicado al proyecto en `~/Library/Application Support/Postgres/var-fefo-16`, puerto `5433`,
superusuario `postgres` / contraseña `fefo-dev` (los mismos valores que usaba el `docker run` de arriba, así que
no hace falta tocar `config.ts` ni variables de entorno).

```sh
./despliegue/pg-local-iniciar.sh       # arranca Postgres 16 (puerto 5433)
npm install
npm run bd:preparar                    # base «fefo»: 01 + 02 + 06; usuarios con contraseña almacen2026
npm run build && COOKIE_SEGURA=0 npm start   # http://localhost:3000
./despliegue/pg-local-detener.sh       # al terminar, si quieres apagar Postgres
```

Para cargar el caso simulado, después de `bd:preparar`:

```sh
python3 programas_P2_v2/sim.py --salida datos/sim_v2
npm run bd:cargar-sim
```

Para desarrollar con recarga en caliente: `npm run dev` (API en el puerto 3000) y `npm run dev:cliente` (Vite en el 5173, con proxy a la API).

Usuarios del catálogo de P3: `alm01`, `alm02` (almacenistas), `sup01`, `sup02` (supervisores) y `adm01` (administración).

## Despliegue en la PC del almacén (ADR-008)

```sh
cd despliegue
cp .env.example .env          # contraseñas e IP fija de la PC (FEFO_HOST)
docker compose up -d --build
docker compose exec api node servidor/dist/tareas/usuarios.js --pendientes <contraseña>
```

- En cada teléfono, abre una vez `http://IP-DE-LA-PC/ca.crt` e instala el certificado. Después usa `https://IP-DE-LA-PC` e instala la aplicación desde Chrome con «Agregar a la pantalla principal».
- Respaldo diario: `sh despliegue/respaldo.sh /ruta/disco-externo`, programado con cron o con el Programador de tareas. La línea para restaurar está en el mismo archivo.

## Pruebas

```sh
npm test                 # 14 unitarias del motor y los IDs + 15 de integración de la API (base fefo_prueba) + 3 del cliente
npm run e2e              # Playwright en un Pixel 7 emulado (servidor en marcha y caso simulado cargado)
npm run rendimiento      # PR-01 con los 5 000 lotes de bd/05_rendimiento.sql
docker exec -i fefo-pg psql -U postgres -d <base recién preparada> -f - < bd/03_pruebas_integridad.sql   # PI-01 a PI-27
```

`npm run e2e` modifica la base de desarrollo: crea un pedido y registra una salida. Para volver al caso original, repite `bd:preparar` y `bd:cargar-sim`.

## Estructura (P3, Sección VI.A)

```
cliente/      PWA: vistas, escaner/ (BarcodeDetector, ZXing, GS1), cola/ (IndexedDB y sincronizador), e2e/
servidor/     API: api/ (rutas y esquemas), seguridad/, dominio/ (fefo, recepcion, ubicaciones, movimientos,
              surtido, alertas, parametros, evaluacion, etiquetas), repositorios/, tareas/
bd/           01_esquema, 02_catalogo, 03_pruebas_integridad, 04_reproducir_sim, 05_rendimiento (P3) y 06_extension_prototipo
despliegue/   Dockerfile, docker-compose.yml, Caddyfile, initdb/, respaldo.sh
adr/          ADR-001 a ADR-009 de P3 y ADR-010 (extensiones del prototipo)
```
