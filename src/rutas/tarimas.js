/**
 * Ficha y etiqueta de tarima; colocación y reubicación por escaneo (RF-06, RF-08) con la regla de frío (RN-05);
 * caducidad efectiva cuando se rompe la cadena de frío (P1 V.G).
 */
const express = require('express');
const QRCode = require('qrcode');
const { q, uno, tx } = require('../db');
const { bitacora, escaneos, requiereSupervisor } = require('../seguridad');
const inv = require('../servicios/inventario');
const R = require('../dominio/reglas');
const { hoy, diasEntre, texto, fechaValida } = require('../util');

const router = express.Router();

/** Normaliza lo que llega de un escaneo o de la captura: sin espacios y en mayúsculas. */
const codigo = (v) => (texto(v, 40) || '').replace(/\s+/g, '').toUpperCase();

async function cargarTarima(id, almacenId) {
  const t = await uno(
    `SELECT t.*, p.zona, p.tipo, p.fila, p.profundidad, p.es_frio
     FROM tarima t LEFT JOIN posicion p ON p.id_posicion = t.id_posicion
     WHERE t.id_tarima = ? AND t.almacen_id = ?`, [id, almacenId]);
  if (!t) return null;
  t.lotes = await q(
    `SELECT tl.id_lote, tl.cajas, l.num_lote, l.sku, l.fecha_caducidad, l.caducidad_efectiva, l.motivo_caducidad_efectiva,
            pr.nombre AS producto, pr.requiere_frio
     FROM tarima_lote tl JOIN lote l ON l.id_lote = tl.id_lote JOIN producto pr ON pr.sku = l.sku
     WHERE tl.id_tarima = ? ORDER BY COALESCE(l.caducidad_efectiva, l.fecha_caducidad)`, [id]);
  t.requiereFrio = t.lotes.some((l) => l.requiere_frio && l.cajas > 0);
  return t;
}

router.get('/tarimas/:id', async (req, res) => {
  const t = await cargarTarima(req.params.id, req.usuario.almacenId);
  if (!t) return res.status(404).render('error', { titulo: 'No encontrada', mensaje: `No hay ninguna tarima ${req.params.id}.` });
  const mapa = await inv.mapaFilas(req.usuario.almacenId);
  const movimientos = await q(
    `SELECT m.*, u.nombre AS usuario, l.num_lote FROM movimiento m
     LEFT JOIN usuario u ON u.id = m.usuario_id LEFT JOIN lote l ON l.id_lote = m.id_lote
     WHERE m.id_tarima = ? ORDER BY m.fecha_hora DESC, m.id DESC LIMIT 50`, [t.id_tarima]);
  for (const l of t.lotes) l.d = diasEntre(hoy(), R.caducidadDe(l));
  res.render('tarimas/ver', {
    titulo: `Tarima ${t.id_tarima}`, t, bloqueadores: inv.bloqueadores(mapa, t), movimientos,
    qr: await QRCode.toString(t.id_tarima, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  });
});

router.get('/tarimas/:id/etiqueta', async (req, res) => {
  const t = await cargarTarima(req.params.id, req.usuario.almacenId);
  if (!t) return res.status(404).render('error', { titulo: 'No encontrada', mensaje: 'Esa tarima no existe.' });
  res.render('tarimas/etiqueta', {
    titulo: `Etiqueta ${t.id_tarima}`, t,
    qr: await QRCode.toString(t.id_tarima, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  });
});

/** Pantalla de ubicar o mover: 1) escanear tarima, 2) escanear posición destino, 3) confirmar. */
router.get('/mover', async (req, res) => {
  const idT = codigo(req.query.tarima);
  let t = null;
  let error = null;
  if (idT) {
    t = await cargarTarima(idT, req.usuario.almacenId);
    if (!t) error = `No hay ninguna tarima ${idT}. Revisa la etiqueta.`;
    else if (t.estado !== 'ACTIVA') error = `La tarima ${idT} ya salió del almacén (vacía).`;
  }
  const previos = Number(req.query.escaneos);
  res.render('tarimas/mover', { titulo: 'Ubicar o mover tarima', t: error ? null : t, error, posicion: codigo(req.query.posicion),
    escaneosPrevios: Number.isInteger(previos) && previos >= 0 && previos < 100 ? previos : 0 });
});

router.post('/mover', async (req, res) => {
  const alm = req.usuario.almacenId;
  const idT = codigo(req.body.tarima);
  const idP = codigo(req.body.posicion);
  const t = await cargarTarima(idT, alm);
  const volver = (error) => res.status(400).render('tarimas/mover', { titulo: 'Ubicar o mover tarima', t, error, posicion: idP,
    escaneosPrevios: escaneos(req) || 0 });
  if (!t || t.estado !== 'ACTIVA') return volver('Escanea una tarima activa.');
  if (!idP) return volver('Escanea la etiqueta de la posición destino.');
  const p = await uno('SELECT * FROM posicion WHERE id_posicion = ? AND almacen_id = ? AND activa = 1', [idP, alm]);
  if (!p) return volver(`La posición ${idP} no existe. Revisa la etiqueta del lugar.`);
  if (t.id_posicion === p.id_posicion) return volver(`La tarima ya está registrada en ${p.id_posicion}.`);
  // RN-05: lo que requiere frío solo va a la cámara
  if (t.requiereFrio && !p.es_frio) return volver(`La tarima trae producto que requiere frío; solo puede ir a una posición de cámara fría.`);
  const ocupante = await uno(`SELECT id_tarima FROM tarima WHERE id_posicion = ? AND estado = 'ACTIVA'`, [p.id_posicion]);
  if (ocupante) return volver(`La posición ${p.id_posicion} ya tiene la tarima ${ocupante.id_tarima}. Muévela primero o elige otro lugar.`);

  const tipo = t.id_posicion ? 'REUBICACION' : 'COLOCACION';
  try {
    await tx(async (con) => {
      const [r] = await con.query(`UPDATE tarima SET id_posicion = ? WHERE id_tarima = ? AND estado = 'ACTIVA' AND (id_posicion <=> ?)`,
        [p.id_posicion, t.id_tarima, t.id_posicion]);
      if (r.affectedRows !== 1) throw Object.assign(new Error('cambio concurrente'), { publico: 'Alguien movió esta tarima al mismo tiempo. Vuelve a escanearla.' });
      await con.query(`INSERT INTO movimiento (almacen_id, tipo, id_tarima, pos_origen, pos_destino, usuario_id, tarea) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [alm, tipo, t.id_tarima, t.id_posicion, p.id_posicion, req.usuario.id, req.session.tarea || null]);
      await bitacora(req, { accion: tipo, entidad: 'tarima', id: t.id_tarima, escaneos: escaneos(req), resultado: 'OK',
        antes: { id_posicion: t.id_posicion }, despues: { id_posicion: p.id_posicion } }, con);
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return volver(`La posición ${p.id_posicion} se acaba de ocupar. Elige otra.`);
    if (e.publico) return volver(e.publico);
    throw e;
  }
  req.flash('ok', `Tarima ${t.id_tarima} ${tipo === 'COLOCACION' ? 'ubicada' : 'movida'} en ${p.id_posicion}.`);
  res.redirect(req.body.siguiente === 'ficha' ? `/tarimas/${t.id_tarima}` : '/mover');
});

/** Caducidad efectiva menor que la impresa, con justificación y responsable; sustituye a la impresa en FEFO y alertas. */
router.post('/lotes/:id/caducidad-efectiva', requiereSupervisor, async (req, res) => {
  const l = await uno('SELECT * FROM lote WHERE id_lote = ?', [req.params.id]);
  const volverA = texto(req.body.volver, 200) || '/';
  if (!l) return res.status(404).render('error', { titulo: 'No encontrado', mensaje: 'Ese lote no existe.' });
  const nueva = texto(req.body.caducidad_efectiva, 10);
  const motivo = texto(req.body.motivo, 200);
  if (!fechaValida(nueva) || nueva >= l.fecha_caducidad) {
    req.flash('error', 'La caducidad efectiva debe ser una fecha válida y anterior a la impresa.');
  } else if (!motivo) {
    req.flash('error', 'Escribe la justificación (por ejemplo, ruptura de la cadena de frío).');
  } else {
    await tx(async (con) => {
      await con.query('UPDATE lote SET caducidad_efectiva = ?, motivo_caducidad_efectiva = ? WHERE id_lote = ?', [nueva, motivo, l.id_lote]);
      await bitacora(req, { accion: 'CADUCIDAD_EFECTIVA', entidad: 'lote', id: l.id_lote, resultado: 'OK',
        antes: { caducidad_efectiva: l.caducidad_efectiva }, despues: { caducidad_efectiva: nueva, motivo } }, con);
    });
    req.flash('ok', `Lote ${l.num_lote}: caducidad efectiva registrada.`);
  }
  res.redirect(volverA.startsWith('/') ? volverA : '/');
});

module.exports = router;
