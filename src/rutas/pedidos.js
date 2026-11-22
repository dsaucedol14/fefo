/**
 * Pedidos y surtido: RF-11 lista FEFO con bloqueos; RF-12 verificar al escanear que el lote sea el propuesto y, si no,
 * exigir motivo de RN-09; RF-13 descontar existencias del lote escaneado (nunca negativas, RNF-07);
 * RF-16 impedir la salida de caducados y proponer su baja.
 */
const express = require('express');
const { q, uno, tx, siguiente, pool } = require('../db');
const { bitacora, escaneos, requiereSupervisor } = require('../seguridad');
const surtido = require('../servicios/surtido');
const inv = require('../servicios/inventario');
const R = require('../dominio/reglas');
const GS1 = require('../dominio/gs1');
const { hoy, texto, entero, lista, fecha } = require('../util');

const router = express.Router();
const codigo = (v) => (texto(v, 200) || '').trim();

router.get('/pedidos', async (req, res) => {
  const pedidos = await q(
    `SELECT p.id, p.folio, p.cliente, p.estado, p.creado_en, p.cerrado_en,
            COUNT(lp.id) AS renglones, SUM(lp.cajas) AS cajas, SUM(lp.cajas_surtidas) AS surtidas
     FROM pedido p LEFT JOIN linea_pedido lp ON lp.pedido_id = p.id
     WHERE p.almacen_id = ? GROUP BY p.id ORDER BY p.estado = 'ABIERTO' DESC, p.id DESC LIMIT 100`, [req.usuario.almacenId]);
  res.render('pedidos/lista', { titulo: 'Pedidos', pedidos });
});

async function productosConExistencia(alm, empresaId) {
  return q(
    `SELECT pr.sku, pr.nombre,
            COALESCE((SELECT SUM(tl.cajas) FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote
                      JOIN tarima t ON t.id_tarima = tl.id_tarima
                      WHERE l.sku = pr.sku AND t.estado = 'ACTIVA' AND t.almacen_id = ?), 0) AS existencia
     FROM producto pr WHERE pr.empresa_id = ? AND pr.activo = 1 ORDER BY pr.nombre`, [alm, empresaId]);
}

router.get('/pedidos/nuevo', requiereSupervisor, async (req, res) => {
  res.render('pedidos/nuevo', { titulo: 'Nuevo pedido', productos: await productosConExistencia(req.usuario.almacenId, req.usuario.empresa_id),
    renglones: [{}], cliente: '', error: null });
});

router.post('/pedidos', requiereSupervisor, async (req, res) => {
  const alm = req.usuario.almacenId;
  const skus = lista(req.body.sku);
  const cajas = lista(req.body.cajas);
  const cliente = texto(req.body.cliente, 150);
  const renglones = [];
  for (let i = 0; i < Math.max(skus.length, cajas.length); i++) {
    const r = { sku: texto(skus[i], 14), cajas: texto(cajas[i], 6) };
    if (r.sku || r.cajas) renglones.push(r);
  }
  const volver = async (error) => res.status(400).render('pedidos/nuevo', { titulo: 'Nuevo pedido',
    productos: await productosConExistencia(alm, req.usuario.empresa_id), renglones: renglones.length ? renglones : [{}], cliente, error });
  if (!renglones.length) return volver('Agrega al menos un renglón.');
  const vistos = new Set();
  for (const [i, r] of renglones.entries()) {
    r.cajasN = entero(r.cajas);
    if (!r.sku) return volver(`Renglón ${i + 1}: elige el producto.`);
    if (!r.cajasN || r.cajasN <= 0 || r.cajasN > 9999) return volver(`Renglón ${i + 1}: las cajas deben ser mayores que cero.`);
    if (vistos.has(r.sku)) return volver(`Renglón ${i + 1}: el producto está repetido; súmalo en un solo renglón.`);
    vistos.add(r.sku);
    if (!(await uno('SELECT sku FROM producto WHERE sku = ? AND empresa_id = ? AND activo = 1', [r.sku, req.usuario.empresa_id]))) {
      return volver(`Renglón ${i + 1}: el producto no existe.`);
    }
  }
  const id = await tx(async (con) => {
    const anio = hoy().slice(0, 4);
    const n = await siguiente(con, `pedido-${alm}-${anio}`);
    const folio = `PED-${anio}-${String(n).padStart(4, '0')}`;
    const [r] = await con.query('INSERT INTO pedido (almacen_id, folio, cliente, creado_por) VALUES (?, ?, ?, ?)', [alm, folio, cliente, req.usuario.id]);
    for (const [i, l] of renglones.entries()) {
      await con.query('INSERT INTO linea_pedido (pedido_id, renglon, sku, cajas) VALUES (?, ?, ?, ?)', [r.insertId, i + 1, l.sku, l.cajasN]);
    }
    await bitacora(req, { accion: 'CREAR_PEDIDO', entidad: 'pedido', id: folio, resultado: 'OK',
      despues: { renglones: renglones.map((l) => ({ sku: l.sku, cajas: l.cajasN })) } }, con);
    return r.insertId;
  });
  await surtido.generarLista(id, alm);
  res.redirect(`/pedidos/${id}`);
});

router.get('/pedidos/:id', async (req, res) => {
  const alm = req.usuario.almacenId;
  // Vuelve a completar la lista por si entraron lotes o se liberaron reservas desde la última vez
  await surtido.generarLista(req.params.id, alm);
  const pedido = await surtido.detalle(req.params.id, alm);
  if (!pedido) return res.status(404).render('error', { titulo: 'No encontrado', mensaje: 'Ese pedido no existe.' });
  res.render('pedidos/ver', { titulo: `Pedido ${pedido.folio}`, pedido });
});

router.post('/pedidos/:id/cancelar', requiereSupervisor, async (req, res) => {
  const p = await uno(`SELECT * FROM pedido WHERE id = ? AND almacen_id = ? AND estado = 'ABIERTO'`, [req.params.id, req.usuario.almacenId]);
  if (p) {
    await tx(async (con) => {
      await con.query(`UPDATE pedido SET estado = 'CANCELADO', cerrado_en = NOW() WHERE id = ?`, [p.id]);
      await con.query(`UPDATE reserva r JOIN linea_pedido lp ON lp.id = r.linea_id SET r.estado = 'LIBERADA'
                       WHERE lp.pedido_id = ? AND r.estado = 'ABIERTA'`, [p.id]);
      await bitacora(req, { accion: 'CANCELAR_PEDIDO', entidad: 'pedido', id: p.folio, resultado: 'OK' }, con);
    });
    req.flash('ok', `Pedido ${p.folio} cancelado; sus reservas quedaron libres.`);
  }
  res.redirect(`/pedidos/${req.params.id}`);
});

async function cargarReserva(id, alm) {
  const r = await uno(
    `SELECT r.*, lp.sku, lp.cajas AS cajas_linea, lp.cajas_surtidas, lp.renglon, lp.pedido_id,
            pe.folio, pe.estado AS estado_pedido, pr.nombre AS producto,
            l.num_lote, l.fecha_caducidad, l.caducidad_efectiva, t.id_posicion, p.zona, p.tipo, p.fila, p.profundidad
     FROM reserva r JOIN linea_pedido lp ON lp.id = r.linea_id JOIN pedido pe ON pe.id = lp.pedido_id
     JOIN producto pr ON pr.sku = lp.sku JOIN lote l ON l.id_lote = r.id_lote
     JOIN tarima t ON t.id_tarima = r.id_tarima LEFT JOIN posicion p ON p.id_posicion = t.id_posicion
     WHERE r.id = ? AND pe.almacen_id = ?`, [id, alm]);
  if (r) r.bloqueadores = inv.bloqueadores(await inv.mapaFilas(alm), r);
  return r;
}

router.get('/surtir/:id', async (req, res) => {
  const r = await cargarReserva(req.params.id, req.usuario.almacenId);
  if (!r) return res.status(404).render('error', { titulo: 'No encontrado', mensaje: 'Ese renglón de surtido no existe.' });
  if (r.estado !== 'ABIERTA' || r.estado_pedido !== 'ABIERTO') return res.redirect(`/pedidos/${r.pedido_id}`);
  res.render('pedidos/surtir', { titulo: `Surtir ${r.folio}`, r, form: {}, error: null, opciones: null, pideMotivo: false, caducado: null });
});

router.post('/surtir/:id', async (req, res) => {
  const alm = req.usuario.almacenId;
  const r = await cargarReserva(req.params.id, alm);
  if (!r) return res.status(404).render('error', { titulo: 'No encontrado', mensaje: 'Ese renglón de surtido no existe.' });
  if (r.estado !== 'ABIERTA' || r.estado_pedido !== 'ABIERTO') {
    req.flash('error', 'Ese renglón ya se surtió o el pedido se cerró.');
    return res.redirect(`/pedidos/${r.pedido_id}`);
  }
  const form = {
    tarima: codigo(req.body.tarima).replace(/\s+/g, '').toUpperCase(),
    lote: codigo(req.body.lote), cajas: texto(req.body.cajas, 6) || String(r.cajas),
    motivo: texto(req.body.motivo, 30), justificacion: texto(req.body.justificacion, 300), escaneos: req.body.escaneos,
  };
  const ver = (extra) => res.status(400).render('pedidos/surtir', {
    titulo: `Surtir ${r.folio}`, r, form, error: null, opciones: null, pideMotivo: false, caducado: null, ...extra });

  if (!form.tarima) return ver({ error: 'Escanea la etiqueta de la tarima de la que vas a sacar.' });
  const t = await uno(`SELECT id_tarima, estado FROM tarima WHERE id_tarima = ? AND almacen_id = ?`, [form.tarima, alm]);
  if (!t || t.estado !== 'ACTIVA') return ver({ error: `No hay una tarima activa ${form.tarima}. Revisa la etiqueta.` });

  // Lotes del producto en la tarima escaneada; si hay varios, se escanea o se elige el lote
  let lotes = await q(
    `SELECT tl.id_lote, tl.cajas, l.num_lote, l.fecha_caducidad, l.caducidad_efectiva
     FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote WHERE tl.id_tarima = ? AND l.sku = ? AND tl.cajas > 0`, [t.id_tarima, r.sku]);
  if (!lotes.length) return ver({ error: `La tarima ${t.id_tarima} no tiene ${r.producto}. Revisa que sea la tarima correcta.` });
  if (form.lote) {
    const gs1 = GS1.leer(form.lote);
    const buscado = gs1 && gs1.lote ? gs1.lote : form.lote;
    lotes = lotes.filter((l) => l.id_lote === form.lote || l.num_lote.toUpperCase() === buscado.toUpperCase());
    if (!lotes.length) return ver({ error: `El lote ${buscado} no está en la tarima ${t.id_tarima}.` });
  }
  if (lotes.length > 1) return ver({ opciones: lotes, error: 'Esta tarima tiene varios lotes de este producto. Escanea la caja o elige el lote que estás sacando.' });
  const elegido = lotes[0];

  // RF-16: un lote caducado no sale; se propone su baja
  if (R.caducado(elegido, hoy())) {
    return ver({ caducado: { ...elegido, id_tarima: t.id_tarima },
      error: `El lote ${elegido.num_lote} caducó el ${fecha(R.caducidadDe(elegido))}. No puede salir; propón su baja.` });
  }

  const conforme = elegido.id_lote === r.id_lote;
  if (!conforme) {
    if (!form.motivo || !R.MOTIVOS[form.motivo]) {
      return ver({ pideMotivo: true, error: `Este no es el lote propuesto (${r.num_lote}). Para continuar elige el motivo de la excepción.`, elegido });
    }
    if (form.motivo === 'DECISION_OPERADOR' && !form.justificacion) {
      return ver({ pideMotivo: true, error: 'Escribe la justificación de la decisión.', elegido });
    }
  }

  const cajas = entero(form.cajas);
  const pendienteLinea = r.cajas_linea - r.cajas_surtidas;
  if (!cajas || cajas <= 0) return ver({ error: 'Las cajas deben ser mayores que cero.', pideMotivo: !conforme, elegido });
  if (cajas > r.cajas) return ver({ error: `Este renglón de la lista es de ${r.cajas} cajas.`, pideMotivo: !conforme, elegido });
  if (cajas > pendienteLinea) return ver({ error: `Al pedido solo le faltan ${pendienteLinea} cajas de este producto.`, pideMotivo: !conforme, elegido });
  if (cajas > elegido.cajas) return ver({ error: `La tarima solo tiene ${elegido.cajas} cajas del lote ${elegido.num_lote}.`, pideMotivo: !conforme, elegido });

  try {
    await tx(async (con) => {
      // RNF-07: el saldo nunca queda negativo aunque dos personas saquen a la vez
      const [u] = await con.query('UPDATE tarima_lote SET cajas = cajas - ? WHERE id_tarima = ? AND id_lote = ? AND cajas >= ?',
        [cajas, t.id_tarima, elegido.id_lote, cajas]);
      if (u.affectedRows !== 1) throw Object.assign(new Error('saldo'), { publico: 'Las existencias cambiaron mientras surtías. Vuelve a escanear.' });
      const mismaPartida = conforme && t.id_tarima === r.id_tarima;
      const [ur] = await con.query(`UPDATE reserva SET estado = ?, cajas = ? WHERE id = ? AND estado = 'ABIERTA'`,
        [mismaPartida ? 'SURTIDA' : 'LIBERADA', mismaPartida ? cajas : r.cajas, r.id]);
      if (ur.affectedRows !== 1) throw Object.assign(new Error('reserva'), { publico: 'Ese renglón ya lo surtió otra persona.' });
      const [ul] = await con.query('UPDATE linea_pedido SET cajas_surtidas = cajas_surtidas + ? WHERE id = ? AND cajas_surtidas + ? <= cajas',
        [cajas, r.linea_id, cajas]);
      if (ul.affectedRows !== 1) throw Object.assign(new Error('linea'), { publico: 'El renglón del pedido ya está completo.' });
      await con.query(
        `INSERT INTO movimiento (almacen_id, tipo, id_tarima, id_lote, cajas, pos_origen, linea_id, lote_propuesto, conforme_fefo,
           motivo_excepcion, justificacion, usuario_id, tarea)
         SELECT ?, 'SALIDA', ?, ?, ?, id_posicion, ?, ?, ?, ?, ?, ?, ? FROM tarima WHERE id_tarima = ?`,
        [alm, t.id_tarima, elegido.id_lote, cajas, r.linea_id, r.id_lote, conforme ? 1 : 0,
          conforme ? null : form.motivo, conforme ? null : form.justificacion, req.usuario.id, req.session.tarea || null, t.id_tarima]);
      // Tarima vacía: sale del almacén y libera su posición
      const [[{ resto }]] = await con.query('SELECT COALESCE(SUM(cajas), 0) AS resto FROM tarima_lote WHERE id_tarima = ?', [t.id_tarima]);
      if (Number(resto) === 0) {
        await con.query(`UPDATE tarima SET estado = 'VACIA', id_posicion = NULL WHERE id_tarima = ?`, [t.id_tarima]);
        await con.query(`UPDATE reserva SET estado = 'LIBERADA' WHERE id_tarima = ? AND estado = 'ABIERTA'`, [t.id_tarima]);
      }
      await bitacora(req, {
        accion: 'SALIDA', entidad: 'tarima', id: t.id_tarima, escaneos: escaneos(req),
        resultado: conforme ? 'CONFORME_FEFO' : 'EXCEPCION',
        antes: { lote_propuesto: r.num_lote, tarima_propuesta: r.id_tarima },
        despues: { lote: elegido.num_lote, cajas, motivo: conforme ? null : form.motivo, pedido: r.folio, tarima_vacia: Number(resto) === 0 },
      }, con);
    });
  } catch (e) {
    if (e.publico) return ver({ error: e.publico });
    throw e;
  }
  await surtido.generarLista(r.pedido_id, alm);
  req.flash('ok', conforme ? `Salida registrada: ${cajas} cajas del lote ${elegido.num_lote}.`
    : `Salida registrada como excepción (${R.MOTIVOS[form.motivo]}).`);
  res.redirect(`/pedidos/${r.pedido_id}`);
});

/** RF-16: propuesta de baja de un lote caducado en una tarima. Queda pendiente; no descuenta existencias. */
router.post('/bajas', async (req, res) => {
  const idLote = texto(req.body.id_lote, 36);
  const idT = texto(req.body.id_tarima, 20);
  const tl = await uno(
    `SELECT tl.cajas, l.num_lote, l.fecha_caducidad, l.caducidad_efectiva FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote
     JOIN tarima t ON t.id_tarima = tl.id_tarima WHERE tl.id_tarima = ? AND tl.id_lote = ? AND t.almacen_id = ?`, [idT, idLote, req.usuario.almacenId]);
  const volver = texto(req.body.volver, 200);
  if (!tl || !R.caducado(tl, hoy())) {
    req.flash('error', 'Solo se propone la baja de un lote caducado.');
  } else {
    const [r] = await pool.query(
      `INSERT IGNORE INTO baja (id_lote, id_tarima, cajas, motivo, registrada_por) VALUES (?, ?, ?, 'CADUCIDAD', ?)`,
      [idLote, idT, tl.cajas, req.usuario.id]);
    if (r.affectedRows) {
      await bitacora(req, { accion: 'PROPONER_BAJA', entidad: 'lote', id: idLote, resultado: 'PENDIENTE',
        despues: { tarima: idT, lote: tl.num_lote, cajas: tl.cajas } });
      req.flash('ok', `Baja propuesta: lote ${tl.num_lote}, ${tl.cajas} cajas. Queda pendiente de autorización del supervisor.`);
    } else {
      req.flash('ok', `La baja del lote ${tl.num_lote} ya estaba propuesta.`);
    }
  }
  res.redirect(volver && volver.startsWith('/') ? volver : '/alertas');
});

module.exports = router;
