/**
 * Prueba de punta a punta contra el servidor en marcha y la base de demostración (npm run demo).
 * Recorre: acceso y aviso, recepción (RF-01/02/04), ubicación por escaneo (RF-06/RN-05), reubicación (RF-08),
 * localización (RF-09), pedido y lista FEFO (RF-11), salida conforme y con excepción (RF-12/13), caducado (RF-16),
 * alertas (RF-14), bloqueo tras 5 intentos (RNF-08) y bitácora de solo inserción (RF-20).
 *
 *   node scripts/prueba-flujo.js [http://localhost:3200]
 */
const assert = require('node:assert/strict');
const { q, uno, pool } = require('../src/db');
const config = require('../src/config');
const { hoy, sumarDias } = require('../src/util');

const BASE = process.argv[2] || `http://localhost:${config.puerto}`;

function cliente() {
  const cookies = new Map();
  let csrf = null;
  async function pedir(ruta, opciones = {}) {
    const r = await fetch(BASE + ruta, {
      redirect: 'manual', ...opciones,
      headers: { ...(opciones.headers || {}), cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of r.headers.getSetCookie()) {
      const [par] = c.split(';');
      const i = par.indexOf('=');
      cookies.set(par.slice(0, i), par.slice(i + 1));
    }
    const texto = await r.text();
    const m = texto.match(/name="_csrf" value="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: r.status, ubicacion: r.headers.get('location'), texto };
  }
  const get = (ruta) => pedir(ruta);
  const post = async (ruta, datos) => {
    if (!csrf) await get('/login');
    const cuerpo = new URLSearchParams();
    for (const [k, v] of Object.entries({ _csrf: csrf, ...datos })) {
      for (const x of [].concat(v)) cuerpo.append(k, x);
    }
    return pedir(ruta, { method: 'POST', body: cuerpo, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  };
  return { get, post };
}

const ok = (msg) => console.log(`  ✔ ${msg}`);

async function main() {
  const admin = cliente();
  await admin.get('/login');
  let r = await admin.post('/login', { usuario: config.admin.usuario, password: config.admin.password });
  assert.equal(r.status, 302, 'login admin');
  r = await admin.get('/');
  if (r.ubicacion === '/aviso-privacidad') {
    await admin.get('/aviso-privacidad');
    await admin.post('/aviso-privacidad', {});
    r = await admin.get('/');
  }
  assert.equal(r.status, 200);
  ok('acceso con aviso de privacidad en el primer ingreso (RNF-09)');

  // RNF-08: el 6.º intento fallido se bloquea aunque la contraseña sea correcta
  const intruso = cliente();
  await intruso.get('/login');
  for (let i = 0; i < 5; i++) await intruso.post('/login', { usuario: 'alm03', password: 'mala' });
  r = await intruso.post('/login', { usuario: 'alm03', password: 'almacen2026' });
  assert.match(r.texto, /Demasiados intentos/);
  ok('bloqueo tras 5 intentos fallidos (RNF-08)');

  // Tarea de evaluación
  await admin.post('/tarea', { tarea: 'PRUEBA-01', volver: '/' });

  // Recepción con dos lotes; uno con vida remanente baja pide autorización
  const prod = await uno(`SELECT sku FROM producto WHERE requiere_frio = 0 ORDER BY sku LIMIT 1`);
  const prod2 = await uno(`SELECT sku FROM producto WHERE requiere_frio = 0 ORDER BY sku LIMIT 1 OFFSET 1`);
  const fecha = hoy();
  r = await admin.post('/recepcion', { sku: [prod.sku, prod2.sku], num_lote: ['PRB-A', 'PRB-B'],
    caducidad: [sumarDias(fecha, 200), sumarDias(fecha, 1)], cajas: ['30', '10'], escaneos: '2' });
  assert.equal(r.status, 400);
  assert.match(r.texto, /Vida remanente por debajo del mínimo/);
  r = await admin.post('/recepcion', { sku: [prod.sku, prod2.sku], num_lote: ['PRB-A', 'PRB-B'],
    caducidad: [sumarDias(fecha, 200), sumarDias(fecha, 1)], cajas: ['30', '10'], escaneos: '2' });
  r = await admin.post('/recepcion', { sku: [prod.sku, prod2.sku], num_lote: ['PRB-A', 'PRB-B'],
    caducidad: [sumarDias(fecha, 200), sumarDias(fecha, 1)], cajas: ['30', '10'], autorizo: '1', escaneos: '2' });
  assert.equal(r.status, 302, 'recepción autorizada');
  const idT = decodeURIComponent(r.ubicacion.split('/').pop());
  assert.match(idT, /^\d{18}$/);
  const lotes = await q('SELECT l.num_lote, tl.cajas FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote WHERE tl.id_tarima = ? ORDER BY l.num_lote', [idT]);
  assert.deepEqual(lotes.map((l) => [l.num_lote, l.cajas]), [['PRB-A', 30], ['PRB-B', 10]]);
  r = await admin.post('/recepcion', { sku: prod.sku, num_lote: 'PRB-C', caducidad: sumarDias(fecha, -1), cajas: '5' });
  assert.match(r.texto, /ya está caducado/);
  ok(`recepción: ID ${idT} con 2 lotes; caducado rechazado; poca vida pide autorización (RF-01, RF-02, RF-04)`);

  // Por ubicar: no aparece para surtir; frío solo en C
  r = await admin.get(`/tarimas/${idT}`);
  assert.match(r.texto, /Por ubicar/);
  const libreB = await uno(`SELECT p.id_posicion FROM posicion p LEFT JOIN tarima t ON t.id_posicion = p.id_posicion AND t.estado='ACTIVA'
                            WHERE p.zona = 'B' AND p.profundidad = 1 AND t.id_tarima IS NULL ORDER BY p.id_posicion LIMIT 1`);
  r = await admin.post('/mover', { tarima: idT, posicion: libreB.id_posicion.toLowerCase(), escaneos: '2' });
  assert.equal(r.status, 302);
  assert.equal((await uno('SELECT id_posicion FROM tarima WHERE id_tarima = ?', [idT])).id_posicion, libreB.id_posicion);
  const ocupada = await uno(`SELECT id_posicion FROM tarima WHERE estado = 'ACTIVA' AND id_posicion IS NOT NULL AND id_tarima <> ? LIMIT 1`, [idT]);
  r = await admin.post('/mover', { tarima: idT, posicion: ocupada.id_posicion });
  assert.match(r.texto, /ya tiene la tarima/);
  const fria = await uno(`SELECT t.id_tarima FROM tarima t JOIN tarima_lote tl ON tl.id_tarima = t.id_tarima JOIN lote l ON l.id_lote = tl.id_lote
                          JOIN producto p ON p.sku = l.sku WHERE p.requiere_frio = 1 AND t.estado = 'ACTIVA' AND tl.cajas > 0 LIMIT 1`);
  r = await admin.post('/mover', { tarima: fria.id_tarima, posicion: libreB.id_posicion.replace('D1', 'D2') });
  assert.match(r.texto, /requiere frío/);
  ok(`colocación por escaneo en ${libreB.id_posicion}; posición ocupada y regla de frío rechazadas (RF-06, RN-05)`);

  // Localizar por lote muestra posición
  r = await admin.get('/localizar?q=PRB-A');
  assert.match(r.texto, new RegExp(libreB.id_posicion));
  r = await admin.get(`/localizar?q=${libreB.id_posicion}`);
  assert.equal(r.ubicacion, `/tarimas/${idT}`);
  ok('localizar por lote y por escaneo de posición (RF-09)');

  // Pedido del producto de una fila con varias profundidades: la propuesta es el lote FEFO aunque esté bloqueado
  const fila = await uno(
    `SELECT l.sku, COUNT(*) AS n FROM tarima t JOIN posicion p ON p.id_posicion = t.id_posicion JOIN tarima_lote tl ON tl.id_tarima = t.id_tarima
     JOIN lote l ON l.id_lote = tl.id_lote WHERE p.tipo = 'PISO' AND p.profundidad > 1 AND t.estado = 'ACTIVA' AND tl.cajas > 0
       AND COALESCE(l.caducidad_efectiva, l.fecha_caducidad) >= ?
     GROUP BY l.sku ORDER BY n DESC LIMIT 1`, [fecha]);
  r = await admin.post('/pedidos', { cliente: 'Escenario prueba', sku: fila.sku, cajas: '5' });
  assert.equal(r.status, 302);
  const idPedido = r.ubicacion.split('/').pop();
  const reserva = await uno(
    `SELECT r.*, l.num_lote, COALESCE(l.caducidad_efectiva, l.fecha_caducidad) AS cad FROM reserva r JOIN linea_pedido lp ON lp.id = r.linea_id
     JOIN lote l ON l.id_lote = r.id_lote WHERE lp.pedido_id = ? AND r.estado = 'ABIERTA' ORDER BY r.id LIMIT 1`, [idPedido]);
  const minimo = await uno(
    `SELECT MIN(COALESCE(l.caducidad_efectiva, l.fecha_caducidad)) AS cad FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote
     JOIN tarima t ON t.id_tarima = tl.id_tarima WHERE l.sku = ? AND tl.cajas > 0 AND t.estado = 'ACTIVA' AND t.id_posicion IS NOT NULL
       AND COALESCE(l.caducidad_efectiva, l.fecha_caducidad) >= ?`, [fila.sku, fecha]);
  assert.equal(reserva.cad, minimo.cad, 'la reserva es el lote de caducidad más próxima');
  r = await admin.get(`/pedidos/${idPedido}`);
  ok(`lista de surtido FEFO: propone ${reserva.num_lote} (caduca ${reserva.cad})${/Bloqueado por/.test(r.texto) ? ', con aviso de bloqueo' : ''} (RF-11, C1)`);

  // Salida con otro lote: exige motivo; con motivo se registra como excepción
  const otro = await uno(
    `SELECT tl.id_tarima, l.id_lote, l.num_lote FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote JOIN tarima t ON t.id_tarima = tl.id_tarima
     WHERE l.sku = ? AND l.id_lote <> ? AND tl.cajas >= 5 AND t.estado = 'ACTIVA' AND COALESCE(l.caducidad_efectiva, l.fecha_caducidad) >= ? LIMIT 1`,
    [fila.sku, reserva.id_lote, fecha]);
  if (otro) {
    r = await admin.post(`/surtir/${reserva.id}`, { tarima: otro.id_tarima, lote: otro.num_lote, cajas: String(Math.min(2, reserva.cajas)) });
    assert.match(r.texto, /no es el lote propuesto/);
    r = await admin.post(`/surtir/${reserva.id}`, { tarima: otro.id_tarima, lote: otro.id_lote, cajas: String(Math.min(2, reserva.cajas)),
      motivo: 'TARIMA_INACCESIBLE', escaneos: '1' });
    assert.equal(r.status, 302);
    const m = await uno(`SELECT conforme_fefo, motivo_excepcion, tarea FROM movimiento WHERE tipo = 'SALIDA' AND linea_id = ? ORDER BY id DESC LIMIT 1`, [reserva.linea_id]);
    assert.deepEqual([m.conforme_fefo, m.motivo_excepcion, m.tarea], [0, 'TARIMA_INACCESIBLE', 'PRUEBA-01']);
    ok('salida fuera de FEFO bloqueada hasta elegir motivo; queda como excepción y no cuenta como conforme (RF-12, RN-09)');
  }

  // Salida conforme con el lote propuesto
  const siguiente = await uno(
    `SELECT r.*, l.num_lote FROM reserva r JOIN linea_pedido lp ON lp.id = r.linea_id JOIN lote l ON l.id_lote = r.id_lote
     WHERE lp.pedido_id = ? AND r.estado = 'ABIERTA' ORDER BY r.id LIMIT 1`, [idPedido]);
  if (siguiente) {
    const antes = await uno('SELECT cajas FROM tarima_lote WHERE id_tarima = ? AND id_lote = ?', [siguiente.id_tarima, siguiente.id_lote]);
    r = await admin.post(`/surtir/${siguiente.id}`, { tarima: siguiente.id_tarima, lote: siguiente.id_lote, cajas: String(siguiente.cajas), escaneos: '1' });
    assert.equal(r.status, 302);
    const despues = await uno('SELECT cajas FROM tarima_lote WHERE id_tarima = ? AND id_lote = ?', [siguiente.id_tarima, siguiente.id_lote]);
    assert.equal(despues.cajas, antes.cajas - siguiente.cajas);
    ok(`salida conforme: el saldo del lote bajó de ${antes.cajas} a ${despues.cajas} (RF-13)`);
  }
  const pedido = await uno('SELECT estado FROM pedido WHERE id = ?', [idPedido]);
  assert.equal(pedido.estado, 'CERRADO');
  ok('el pedido se cerró al completar los renglones');

  // Caducado: no sale y se propone baja
  const venc = await uno(
    `SELECT tl.id_tarima, l.id_lote, l.sku, l.num_lote FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote JOIN tarima t ON t.id_tarima = tl.id_tarima
     WHERE COALESCE(l.caducidad_efectiva, l.fecha_caducidad) < ? AND tl.cajas > 0 AND t.estado = 'ACTIVA' AND t.id_posicion IS NOT NULL LIMIT 1`, [fecha]);
  if (venc) {
    r = await admin.post('/pedidos', { sku: venc.sku, cajas: '1' });
    const idP2 = r.ubicacion.split('/').pop();
    const res2 = await uno(`SELECT r.id FROM reserva r JOIN linea_pedido lp ON lp.id = r.linea_id WHERE lp.pedido_id = ? AND r.estado = 'ABIERTA' LIMIT 1`, [idP2]);
    const reservoVencido = await uno(`SELECT COUNT(*) AS n FROM reserva r JOIN linea_pedido lp ON lp.id = r.linea_id WHERE lp.pedido_id = ? AND r.id_lote = ?`, [idP2, venc.id_lote]);
    assert.equal(reservoVencido.n, 0, 'nunca se reserva un lote caducado (RN-02)');
    if (res2) {
      r = await admin.post(`/surtir/${res2.id}`, { tarima: venc.id_tarima, lote: venc.id_lote, cajas: '1' });
      assert.match(r.texto, /caducó/);
    }
    r = await admin.post('/bajas', { id_lote: venc.id_lote, id_tarima: venc.id_tarima, volver: '/alertas' });
    assert.equal(r.status, 302);
    assert.equal((await uno(`SELECT COUNT(*) AS n FROM baja WHERE id_lote = ? AND estado = 'PENDIENTE'`, [venc.id_lote])).n, 1);
    await admin.post(`/pedidos/${idP2}/cancelar`, {});
    ok(`lote caducado ${venc.num_lote}: no se reserva, su salida se impide y se propone la baja (RN-02, RF-16)`);
  }

  // Alertas y páginas principales
  for (const ruta of ['/alertas', '/alertas?nivel=CRITICO', '/posiciones', '/posiciones/etiquetas?zona=B', '/admin/bitacora',
    '/admin/categorias', '/admin/productos', '/admin/usuarios', '/pedidos', '/localizar', '/mover', '/recepcion', '/cuenta']) {
    r = await admin.get(ruta);
    assert.equal(r.status, 200, ruta);
  }
  ok('alertas, mapa, etiquetas y administración responden (RF-14)');

  // Rol: un almacenista no crea pedidos ni entra a administración
  const alm = cliente();
  await alm.get('/login');
  await alm.post('/login', { usuario: 'alm01', password: 'almacen2026' });
  await alm.get('/aviso-privacidad');
  await alm.post('/aviso-privacidad', {});
  assert.equal((await alm.get('/pedidos/nuevo')).status, 403);
  assert.equal((await alm.get('/admin/bitacora')).status, 403);
  ok('control por rol: el almacenista no autoriza ni administra (RF-21)');

  // RF-20: la bitácora no se puede editar ni borrar
  await assert.rejects(q('UPDATE bitacora SET resultado = "X" ORDER BY id DESC LIMIT 1'), /solo inserción/);
  await assert.rejects(q('DELETE FROM movimiento ORDER BY id DESC LIMIT 1'), /solo inserción/);
  const eventos = await uno(`SELECT COUNT(*) AS n FROM bitacora WHERE tarea = 'PRUEBA-01'`);
  assert.ok(eventos.n >= 5);
  ok(`bitácora: ${eventos.n} eventos ligados a la tarea PRUEBA-01; UPDATE y DELETE rechazados (RF-20)`);

  // RNF-07: ningún saldo negativo
  const neg = await uno('SELECT COUNT(*) AS n FROM tarima_lote WHERE cajas < 0');
  assert.equal(neg.n, 0);
  ok('ningún saldo negativo (RNF-07)');
  await admin.post('/tarea', { tarea: '', volver: '/' });
  await pool.end();
  console.log('\nTodo bien.');
}

main().catch(async (e) => {
  console.error('\n✘', e.message);
  await pool.end();
  process.exit(1);
});
