/**
 * Lista de surtido FEFO (RF-11): para cada renglón del pedido reserva cajas de los lotes en orden RN-01.
 * Las reservas evitan que dos pedidos tomen las mismas cajas (CF2). Se recalcula después de cada salida.
 */
const { q, txConCandado } = require('../db');
const inv = require('./inventario');
const R = require('../dominio/reglas');
const { hoy } = require('../util');

async function generarLista(pedidoId, almacenId) {
  return txConCandado(`fefo-surtido-${almacenId}`, async (con) => {
    const [[pedido]] = await con.query('SELECT estado FROM pedido WHERE id = ? AND almacen_id = ?', [pedidoId, almacenId]);
    if (!pedido || pedido.estado !== 'ABIERTO') return;
    const lineas = await q(
      `SELECT lp.*, lp.cajas - lp.cajas_surtidas - COALESCE((SELECT SUM(r.cajas) FROM reserva r
         WHERE r.linea_id = lp.id AND r.estado = 'ABIERTA'), 0) AS pendiente
       FROM linea_pedido lp WHERE lp.pedido_id = ? ORDER BY lp.renglon`, [pedidoId], con);
    for (const l of lineas) {
      if (l.pendiente <= 0) continue;
      const cands = await inv.candidatos(l.sku, almacenId, con);
      const { partidas } = R.asignarFefo(cands, l.pendiente, hoy());
      for (const p of partidas) {
        await con.query('INSERT INTO reserva (linea_id, id_lote, id_tarima, cajas) VALUES (?, ?, ?, ?)', [l.id, p.id_lote, p.id_tarima, p.cajas]);
      }
    }
    // Cierra el pedido cuando todos los renglones están surtidos
    const [[{ faltan }]] = await con.query('SELECT COUNT(*) AS faltan FROM linea_pedido WHERE pedido_id = ? AND cajas_surtidas < cajas', [pedidoId]);
    if (faltan === 0) await con.query(`UPDATE pedido SET estado = 'CERRADO', cerrado_en = NOW() WHERE id = ?`, [pedidoId]);
  });
}

/** Pedido con sus renglones y las reservas abiertas de cada uno, con posición y bloqueos (C1). */
async function detalle(pedidoId, almacenId) {
  const pedido = (await q(
    `SELECT p.*, u.nombre AS creado_por_nombre FROM pedido p LEFT JOIN usuario u ON u.id = p.creado_por
     WHERE p.id = ? AND p.almacen_id = ?`, [pedidoId, almacenId]))[0];
  if (!pedido) return null;
  pedido.lineas = await q(
    `SELECT lp.*, pr.nombre AS producto FROM linea_pedido lp JOIN producto pr ON pr.sku = lp.sku
     WHERE lp.pedido_id = ? ORDER BY lp.renglon`, [pedidoId]);
  const reservas = await q(
    `SELECT r.*, l.num_lote, l.fecha_caducidad, l.caducidad_efectiva, t.id_posicion, p.zona, p.tipo, p.fila, p.profundidad
     FROM reserva r JOIN linea_pedido lp ON lp.id = r.linea_id
     JOIN lote l ON l.id_lote = r.id_lote JOIN tarima t ON t.id_tarima = r.id_tarima
     LEFT JOIN posicion p ON p.id_posicion = t.id_posicion
     WHERE lp.pedido_id = ? AND r.estado = 'ABIERTA' ORDER BY lp.renglon, r.id`, [pedidoId]);
  const mapa = await inv.mapaFilas(almacenId);
  for (const l of pedido.lineas) {
    l.reservas = reservas.filter((r) => r.linea_id === l.id);
    for (const r of l.reservas) r.bloqueadores = inv.bloqueadores(mapa, r);
    l.reservado = l.reservas.reduce((s, r) => s + r.cajas, 0);
    l.sinExistencia = Math.max(0, l.cajas - l.cajas_surtidas - l.reservado);
  }
  pedido.salidas = await q(
    `SELECT m.*, l.num_lote, lp2.num_lote AS num_lote_propuesto, u.nombre AS usuario, lp.renglon
     FROM movimiento m JOIN linea_pedido lp ON lp.id = m.linea_id
     LEFT JOIN lote l ON l.id_lote = m.id_lote LEFT JOIN lote lp2 ON lp2.id_lote = m.lote_propuesto
     LEFT JOIN usuario u ON u.id = m.usuario_id
     WHERE lp.pedido_id = ? AND m.tipo = 'SALIDA' ORDER BY m.fecha_hora`, [pedidoId]);
  return pedido;
}

module.exports = { generarLista, detalle };
