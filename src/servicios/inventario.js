/** Consultas de inventario que usan varias pantallas: candidatos FEFO, bloqueos por profundidad, alertas y demanda. */
const config = require('../config');
const { q } = require('../db');
const R = require('../dominio/reglas');
const { hoy, diasEntre, sumarDias } = require('../util');

/**
 * Lotes de un producto en tarimas activas, con su posición y las cajas libres (cajas − reservas abiertas, CF2).
 */
async function candidatos(sku, almacenId, con) {
  return q(
    `SELECT tl.id_tarima, tl.id_lote, tl.cajas, l.num_lote, l.sku, l.fecha_caducidad, l.caducidad_efectiva,
            l.fecha_recepcion, t.id_posicion, p.zona, p.tipo, p.fila, p.profundidad,
            tl.cajas - COALESCE((SELECT SUM(r.cajas) FROM reserva r
              WHERE r.id_tarima = tl.id_tarima AND r.id_lote = tl.id_lote AND r.estado = 'ABIERTA'), 0) AS libres
     FROM tarima_lote tl
     JOIN lote l ON l.id_lote = tl.id_lote
     JOIN tarima t ON t.id_tarima = tl.id_tarima
     LEFT JOIN posicion p ON p.id_posicion = t.id_posicion
     WHERE l.sku = ? AND t.almacen_id = ? AND t.estado = 'ACTIVA' AND tl.cajas > 0`,
    [sku, almacenId], con);
}

/** Tarimas que ocupan posiciones de piso, agrupadas por fila: base para saber qué bloquea a qué (RF-07). */
async function mapaFilas(almacenId, con) {
  const filas = await q(
    `SELECT p.fila, p.profundidad, p.id_posicion, t.id_tarima
     FROM posicion p JOIN tarima t ON t.id_posicion = p.id_posicion AND t.estado = 'ACTIVA'
     WHERE p.almacen_id = ? AND p.tipo = 'PISO' AND p.fila IS NOT NULL`, [almacenId], con);
  const mapa = new Map();
  for (const f of filas) {
    if (!mapa.has(f.fila)) mapa.set(f.fila, []);
    mapa.get(f.fila).push(f);
  }
  return mapa;
}

/** Tarimas que hay que mover para llegar a una posición de piso: las de la misma fila con menor profundidad. */
function bloqueadores(mapa, posicion) {
  if (!posicion || posicion.tipo !== 'PISO' || !posicion.fila) return [];
  return (mapa.get(posicion.fila) || [])
    .filter((o) => o.profundidad < posicion.profundidad)
    .sort((a, b) => a.profundidad - b.profundidad);
}

/** Demanda media diaria (cajas) por producto en los 14 días previos a la fecha de operación. */
async function demandaMedia(almacenId, con) {
  const fin = hoy();
  const inicio = sumarDias(fin, -config.diasDemanda);
  const filas = await q(
    `SELECT l.sku, SUM(m.cajas) AS cajas FROM movimiento m JOIN lote l ON l.id_lote = m.id_lote
     WHERE m.tipo = 'SALIDA' AND m.almacen_id = ? AND m.fecha_hora >= ? AND m.fecha_hora < ?
     GROUP BY l.sku`, [almacenId, inicio, sumarDias(fin, 1)], con);
  return new Map(filas.map((f) => [f.sku, Number(f.cajas) / config.diasDemanda]));
}

/**
 * Alertas de caducidad (RF-14, RN-07): cada lote con existencias recibe su nivel según U(c) y la marca de riesgo
 * por rotación. Incluye las tarimas donde está y si alguna está bloqueada (dato de RF-07).
 */
async function alertas(almacenId) {
  const lotes = await q(
    `SELECT l.id_lote, l.sku, l.num_lote, l.fecha_caducidad, l.caducidad_efectiva, l.fecha_recepcion,
            pr.nombre AS producto, c.nombre AS categoria, c.vu_dias, c.vmr_dias, c.tr_dias, c.ms_dias,
            tl.id_tarima, tl.cajas, t.id_posicion, p.tipo, p.fila, p.profundidad, p.zona
     FROM tarima_lote tl
     JOIN tarima t ON t.id_tarima = tl.id_tarima AND t.estado = 'ACTIVA'
     JOIN lote l ON l.id_lote = tl.id_lote
     JOIN producto pr ON pr.sku = l.sku
     JOIN categoria c ON c.id = pr.categoria_id
     LEFT JOIN posicion p ON p.id_posicion = t.id_posicion
     WHERE t.almacen_id = ? AND tl.cajas > 0
     ORDER BY COALESCE(l.caducidad_efectiva, l.fecha_caducidad), l.id_lote, p.profundidad`, [almacenId]);
  const demanda = await demandaMedia(almacenId);
  const mapa = await mapaFilas(almacenId);
  const fecha = hoy();

  const porLote = new Map();
  for (const f of lotes) {
    if (!porLote.has(f.id_lote)) {
      const { U, supuesto } = R.umbral(f, config.umbralOmision);
      porLote.set(f.id_lote, { ...f, U, supuesto, cajas: 0, tarimas: [] });
    }
    const a = porLote.get(f.id_lote);
    a.cajas += f.cajas;
    a.tarimas.push({ id_tarima: f.id_tarima, cajas: f.cajas, id_posicion: f.id_posicion, tipo: f.tipo, profundidad: f.profundidad,
      bloqueadores: bloqueadores(mapa, f) });
  }

  const resultado = [];
  for (const a of porLote.values()) {
    const d = diasEntre(fecha, R.caducidadDe(a));
    const nivel = R.nivelAlerta(d, a.U);
    const dbar = demanda.get(a.sku) || 0;
    const rotacion = R.riesgoRotacion({ R: d, Q: a.cajas, demanda: dbar, vmr: a.vmr_dias, tr: a.tr_dias });
    if (nivel || rotacion) {
      resultado.push({ ...a, d, nivel, rotacion, demanda: dbar, bloqueado: a.tarimas.some((t) => t.bloqueadores.length) });
    }
  }
  return resultado;
}

/** Datos de un lote necesarios para validar su recepción (RN-03): categoría y demanda. */
async function datosRecepcion(sku, almacenId) {
  const p = (await q(
    `SELECT pr.sku, pr.nombre, pr.requiere_frio, c.vmr_dias, c.tr_dias, c.vu_dias, c.ms_dias
     FROM producto pr JOIN categoria c ON c.id = pr.categoria_id WHERE pr.sku = ? AND pr.activo = 1`, [sku]))[0];
  if (!p) return null;
  const demanda = await demandaMedia(almacenId);
  return { producto: p, demanda: demanda.get(sku) || 0 };
}

module.exports = { candidatos, mapaFilas, bloqueadores, demandaMedia, alertas, datosRecepcion };
