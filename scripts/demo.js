/**
 * Datos de demostración del caso simulado [S] «Distribuidora Sierra Norte» (nombre ficticio), con semilla fija.
 * Sirve para probar el prototipo sin el libro del Anexo C. Las caducidades se calculan desde la fecha de operación.
 *
 *   node scripts/demo.js --reiniciar     borra la base y la vuelve a crear con datos de demostración
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { reiniciarBase, generador, posicionesCaso } = require('./comun');

async function main() {
  if (!process.argv.includes('--reiniciar')) {
    console.log('Este script BORRA la base de datos y la llena con datos de demostración.');
    console.log('Para confirmarlo ejecútalo así:  node scripts/demo.js --reiniciar');
    process.exit(1);
  }
  await reiniciarBase();
  const { preparar } = require('../src/esquema');
  await preparar();
  const { pool, q } = require('../src/db');
  const { hoy, sumarDias } = require('../src/util');
  const { idTarima } = require('../src/dominio/ids');
  const azar = generador(20261117);
  const fecha = hoy();

  await q(`UPDATE empresa SET nombre = 'Distribuidora Sierra Norte (simulada)' WHERE id = 1`);
  await q(`UPDATE almacen SET nombre = 'Almacén central' WHERE id = 1`);

  const pass = await bcrypt.hash('almacen2026', 10);
  for (const [usuario, nombre, rol] of [['sup01', 'Supervisor 01', 'SUPERVISOR'], ['alm01', 'Almacenista 01', 'ALMACENISTA'],
    ['alm02', 'Almacenista 02', 'ALMACENISTA'], ['alm03', 'Almacenista 03', 'ALMACENISTA']]) {
    await q('INSERT INTO usuario (empresa_id, usuario, nombre, password_hash, rol) VALUES (1, ?, ?, ?, ?)', [usuario, nombre, pass, rol]);
  }

  // Parámetros de U(c) con los ejemplos de la Sección VII.E
  const categorias = [
    ['Lácteos', 'REFRIGERADO', 22, 3, 2, 2], ['Embutidos', 'REFRIGERADO', 35, 5, 3, 3],
    ['Abarrotes', 'AMBIENTE', 365, 30, 5, 5], ['Bebidas', 'AMBIENTE', 180, 20, 5, 5], ['Botanas', 'AMBIENTE', 120, 15, 5, 5],
  ];
  const idCat = {};
  for (const c of categorias) {
    const [r] = await pool.query('INSERT INTO categoria (empresa_id, nombre, conservacion, vu_dias, vmr_dias, tr_dias, ms_dias) VALUES (1, ?, ?, ?, ?, ?, ?)', c);
    idCat[c[0]] = r.insertId;
  }
  const productos = [
    ['7501000000011', 'Leche entera 1 L caja 12', 'Lácteos', 22, 1, 186], ['7501000000028', 'Yogur natural 1 kg caja 6', 'Lácteos', 25, 1, 210],
    ['7501000000035', 'Queso panela 400 g caja 10', 'Lácteos', 20, 1, 420], ['7501000000042', 'Jamón de pavo 1 kg caja 8', 'Embutidos', 35, 1, 640],
    ['7501000000059', 'Salchicha viena 500 g caja 12', 'Embutidos', 40, 1, 380], ['7501000000066', 'Arroz 1 kg bulto 10', 'Abarrotes', 365, 0, 210],
    ['7501000000073', 'Frijol negro 1 kg bulto 10', 'Abarrotes', 365, 0, 260], ['7501000000080', 'Aceite vegetal 1 L caja 12', 'Abarrotes', 300, 0, 390],
    ['7501000000097', 'Atún en agua 140 g caja 24', 'Abarrotes', 720, 0, 430], ['7501000000103', 'Refresco cola 600 ml paquete 24', 'Bebidas', 150, 0, 290],
    ['7501000000110', 'Agua natural 1 L paquete 12', 'Bebidas', 365, 0, 95], ['7501000000127', 'Jugo de naranja 1 L caja 12', 'Bebidas', 90, 0, 240],
    ['7501000000134', 'Papas fritas 45 g caja 40', 'Botanas', 120, 0, 350], ['7501000000141', 'Galletas surtidas 600 g caja 12', 'Botanas', 180, 0, 300],
  ];
  for (const [sku, nombre, cat, vu, frio, costo] of productos) {
    await q('INSERT INTO producto (sku, empresa_id, nombre, categoria_id, vida_util_dias, requiere_frio, costo_caja) VALUES (?, 1, ?, ?, ?, ?, ?)',
      [sku, nombre, idCat[cat], vu, frio, costo]);
  }

  const posiciones = posicionesCaso();
  for (const p of posiciones) {
    await q('INSERT INTO posicion (id_posicion, almacen_id, zona, tipo, fila, profundidad, es_frio) VALUES (?, 1, ?, ?, ?, ?, ?)',
      [p.id, p.zona, p.tipo, p.fila, p.prof, p.frio]);
  }

  // Tarimas: frío a la zona C; ambiente a racks de A y a filas de B (se llenan del fondo al frente)
  const libresC = posiciones.filter((p) => p.zona === 'C').map((p) => p.id);
  const libresA = posiciones.filter((p) => p.zona === 'A').map((p) => p.id);
  const filasB = [];
  for (let f = 1; f <= 28; f++) filasB.push([4, 3, 2, 1].map((d) => `B-F${String(f).padStart(2, '0')}-D${d}`));
  let serie = 0;
  let nLote = 0;

  async function tarimaCon(lotes, posicion, diasAtras) {
    const id = idTarima('0750123', ++serie);
    const recibida = sumarDias(fecha, -diasAtras);
    await q(`INSERT INTO tarima (id_tarima, almacen_id, id_posicion, fecha_recepcion, recibido_por) VALUES (?, 1, ?, ?, 1)`, [id, posicion, `${recibida} 08:00:00`]);
    await q(`INSERT INTO movimiento (almacen_id, tipo, id_tarima, cajas, usuario_id, fecha_hora) VALUES (1, 'ENTRADA', ?, 0, 1, ?)`, [id, `${recibida} 08:00:00`]);
    for (const l of lotes) {
      const idLote = crypto.randomUUID();
      const num = `L${String(++nLote).padStart(5, '0')}`;
      await q('INSERT INTO lote (id_lote, sku, num_lote, fecha_caducidad, fecha_recepcion) VALUES (?, ?, ?, ?, ?)',
        [idLote, l.sku, num, sumarDias(fecha, l.dias), recibida]);
      await q('INSERT INTO tarima_lote (id_tarima, id_lote, cajas) VALUES (?, ?, ?)', [id, idLote, l.cajas]);
    }
    if (posicion) {
      await q(`INSERT INTO movimiento (almacen_id, tipo, id_tarima, pos_destino, usuario_id, fecha_hora) VALUES (1, 'COLOCACION', ?, ?, 1, ?)`,
        [id, posicion, `${recibida} 08:20:00`]);
    }
    return id;
  }

  const frios = productos.filter((p) => p[4]);
  const ambiente = productos.filter((p) => !p[4]);
  // Frío: 20 tarimas en C, con lotes de pocos días (umbral U = 7 en lácteos)
  for (let i = 0; i < 20; i++) {
    const p = azar.elegir(frios);
    // Las dos primeras ya vencieron, para ver el bloqueo de salida y la propuesta de baja (RF-16)
    const dias = i < 2 ? -1 - i : azar.entero(0, p[3] - 2);
    await tarimaCon([{ sku: p[0], dias, cajas: azar.entero(20, 48) }], libresC.shift(), azar.entero(1, 10));
  }
  // Ambiente en filas de piso: el fondo de cada fila tiende a tener el lote más próximo a caducar (el caso que P2 describe)
  for (let f = 0; f < 24; f++) {
    const p = azar.elegir(ambiente);
    const profundidades = azar.entero(2, 4);
    const fondo = azar.entero(5, Math.max(10, Math.floor(p[3] * 0.25)));
    for (let k = 0; k < profundidades; k++) {
      const mixta = azar() < 0.2 ? [{ sku: azar.elegir(ambiente)[0], dias: azar.entero(40, p[3]), cajas: azar.entero(5, 20) }] : [];
      await tarimaCon([{ sku: p[0], dias: fondo + k * azar.entero(10, 40), cajas: azar.entero(20, 60) }, ...mixta],
        filasB[f][k], 40 - k * 5);
    }
  }
  // Ambiente en racks
  for (let i = 0; i < 60; i++) {
    const p = azar.elegir(ambiente);
    await tarimaCon([{ sku: p[0], dias: azar.entero(10, p[3]), cajas: azar.entero(20, 60) }], libresA.shift(), azar.entero(1, 60));
  }
  // Dos tarimas recién recibidas por ubicar
  for (let i = 0; i < 2; i++) {
    const p = azar.elegir(ambiente);
    await tarimaCon([{ sku: p[0], dias: p[3] - 5, cajas: 40 }], null, 0);
  }
  // Salidas de los 14 días previos para la demanda media del criterio por rotación
  const lotes = await q('SELECT tl.id_tarima, tl.id_lote, l.sku FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote');
  for (let d = 1; d <= 14; d++) {
    for (let k = 0; k < 6; k++) {
      const l = azar.elegir(lotes);
      await q(`INSERT INTO movimiento (almacen_id, tipo, id_tarima, id_lote, cajas, usuario_id, fecha_hora, origen_dato)
               VALUES (1, 'SALIDA', ?, ?, ?, 1, ?, 'IMPORTADO')`, [l.id_tarima, l.id_lote, azar.entero(2, 12), `${sumarDias(fecha, -d)} 12:00:00`]);
    }
  }
  // La serie de IDs continúa después de las tarimas de demostración
  await q(`INSERT INTO serie (nombre, ultimo) VALUES ('tarima-1', ?) ON DUPLICATE KEY UPDATE ultimo = VALUES(ultimo)`, [serie]);
  const [[t]] = await pool.query('SELECT COUNT(*) AS n FROM tarima');
  console.log(`Listo: ${posiciones.length} posiciones, ${productos.length} productos, ${t.n} tarimas, ${nLote} lotes.`);
  console.log('Usuarios: admin (contraseña del .env), sup01, alm01, alm02, alm03 (contraseña almacen2026).');
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
