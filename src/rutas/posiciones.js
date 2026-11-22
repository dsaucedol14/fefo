/** Mapa de ocupación por zona y fila (RF-07 a la vista) y hojas de etiquetas QR para las posiciones (RF-06). */
const express = require('express');
const QRCode = require('qrcode');
const { q } = require('../db');
const { requiereSupervisor } = require('../seguridad');
const R = require('../dominio/reglas');
const config = require('../config');
const { hoy, diasEntre } = require('../util');

const router = express.Router();
const PESO = { VENCIDO: 4, CRITICO: 3, ALTO: 2, PREVENTIVO: 1 };

/** Grupo visual de una posición: la fila de piso, o en rack el pasillo y rack (sin el nivel). */
function grupoDe(p) {
  if (p.fila) return p.fila;
  const partes = p.id_posicion.split('-');
  return partes.length > 2 ? partes.slice(0, -1).join('-') : p.zona;
}

router.get('/posiciones', async (req, res) => {
  const alm = req.usuario.almacenId;
  const posiciones = await q(
    `SELECT p.*, t.id_tarima FROM posicion p
     LEFT JOIN tarima t ON t.id_posicion = p.id_posicion AND t.estado = 'ACTIVA'
     WHERE p.almacen_id = ? AND p.activa = 1 ORDER BY p.zona, p.id_posicion`, [alm]);
  // Peor nivel de alerta de los lotes de cada tarima, para colorear el mapa
  const lotes = await q(
    `SELECT tl.id_tarima, l.fecha_caducidad, l.caducidad_efectiva, c.vu_dias, c.vmr_dias, c.tr_dias, c.ms_dias
     FROM tarima_lote tl JOIN tarima t ON t.id_tarima = tl.id_tarima AND t.estado = 'ACTIVA' AND t.almacen_id = ?
     JOIN lote l ON l.id_lote = tl.id_lote JOIN producto pr ON pr.sku = l.sku JOIN categoria c ON c.id = pr.categoria_id
     WHERE tl.cajas > 0`, [alm]);
  const fecha = hoy();
  const peor = new Map();
  for (const l of lotes) {
    const nivel = R.nivelAlerta(diasEntre(fecha, R.caducidadDe(l)), R.umbral(l, config.umbralOmision).U);
    if (nivel && (PESO[nivel] > (PESO[peor.get(l.id_tarima)] || 0))) peor.set(l.id_tarima, nivel);
  }
  const zonas = new Map();
  for (const p of posiciones) {
    p.nivel = p.id_tarima ? peor.get(p.id_tarima) || null : null;
    if (!zonas.has(p.zona)) zonas.set(p.zona, { zona: p.zona, tipo: p.tipo, frio: !!p.es_frio, grupos: new Map(), total: 0, ocupadas: 0 });
    const z = zonas.get(p.zona);
    const g = grupoDe(p);
    if (!z.grupos.has(g)) z.grupos.set(g, []);
    z.grupos.get(g).push(p);
    z.total++;
    if (p.id_tarima) z.ocupadas++;
  }
  for (const z of zonas.values()) {
    for (const celdas of z.grupos.values()) {
      celdas.sort((a, b) => (a.fila ? a.profundidad - b.profundidad : b.id_posicion.localeCompare(a.id_posicion)));
    }
  }
  res.render('posiciones/mapa', { titulo: 'Mapa del almacén', zonas: [...zonas.values()] });
});

router.get('/posiciones/etiquetas', requiereSupervisor, async (req, res) => {
  const zona = typeof req.query.zona === 'string' ? req.query.zona.slice(0, 4) : '';
  const zonas = await q('SELECT DISTINCT zona FROM posicion WHERE almacen_id = ? ORDER BY zona', [req.usuario.almacenId]);
  const posiciones = zona ? await q('SELECT id_posicion, tipo, profundidad FROM posicion WHERE almacen_id = ? AND zona = ? AND activa = 1 ORDER BY id_posicion',
    [req.usuario.almacenId, zona]) : [];
  for (const p of posiciones) p.qr = await QRCode.toString(p.id_posicion, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.render('posiciones/etiquetas', { titulo: 'Etiquetas de posiciones', zonas, zona, posiciones });
});

module.exports = router;
