/** RF-14: alertas de caducidad por U(c) y criterio por rotación (RN-07); bajas propuestas (RF-16). */
const express = require('express');
const { q } = require('../db');
const inv = require('../servicios/inventario');

const router = express.Router();
const ORDEN = { VENCIDO: 0, CRITICO: 1, ALTO: 2, PREVENTIVO: 3 };

router.get('/alertas', async (req, res) => {
  const filtro = ['VENCIDO', 'CRITICO', 'ALTO', 'PREVENTIVO', 'ROTACION', 'BLOQUEADO'].includes(req.query.nivel) ? req.query.nivel : null;
  let alertas = await inv.alertas(req.usuario.almacenId);
  const conteo = { VENCIDO: 0, CRITICO: 0, ALTO: 0, PREVENTIVO: 0, ROTACION: 0, BLOQUEADO: 0 };
  for (const a of alertas) {
    if (a.nivel) conteo[a.nivel]++;
    if (a.rotacion) conteo.ROTACION++;
    if (a.bloqueado && a.nivel && a.nivel !== 'VENCIDO') conteo.BLOQUEADO++;
  }
  if (filtro === 'ROTACION') alertas = alertas.filter((a) => a.rotacion);
  else if (filtro === 'BLOQUEADO') alertas = alertas.filter((a) => a.bloqueado && a.nivel && a.nivel !== 'VENCIDO');
  else if (filtro) alertas = alertas.filter((a) => a.nivel === filtro);
  alertas.sort((a, b) => (ORDEN[a.nivel] ?? 4) - (ORDEN[b.nivel] ?? 4) || a.d - b.d);

  const bajas = await q(
    `SELECT b.*, l.num_lote, pr.nombre AS producto, u.nombre AS registro FROM baja b
     JOIN lote l ON l.id_lote = b.id_lote JOIN producto pr ON pr.sku = l.sku LEFT JOIN usuario u ON u.id = b.registrada_por
     JOIN tarima t ON t.id_tarima = b.id_tarima
     WHERE b.estado = 'PENDIENTE' AND t.almacen_id = ? ORDER BY b.creado_en DESC`, [req.usuario.almacenId]);
  res.render('alertas', { titulo: 'Alertas de caducidad', alertas, conteo, filtro, bajas });
});

module.exports = router;
