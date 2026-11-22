const express = require('express');
const { q, uno } = require('../db');
const inv = require('../servicios/inventario');

const router = express.Router();

router.get('/', async (req, res) => {
  const alm = req.usuario.almacenId;
  const [porUbicar, ocupacion, pedidos, alertas] = await Promise.all([
    uno(`SELECT COUNT(*) AS n FROM tarima WHERE almacen_id = ? AND estado = 'ACTIVA' AND id_posicion IS NULL`, [alm]),
    uno(`SELECT COUNT(*) AS total, SUM(t.id_tarima IS NOT NULL) AS ocupadas
         FROM posicion p LEFT JOIN tarima t ON t.id_posicion = p.id_posicion AND t.estado = 'ACTIVA'
         WHERE p.almacen_id = ? AND p.activa = 1`, [alm]),
    q(`SELECT id, folio, cliente, creado_en FROM pedido WHERE almacen_id = ? AND estado = 'ABIERTO' ORDER BY id LIMIT 8`, [alm]),
    inv.alertas(alm),
  ]);
  const niveles = { VENCIDO: 0, CRITICO: 0, ALTO: 0, PREVENTIVO: 0, ROTACION: 0 };
  for (const a of alertas) {
    if (a.nivel) niveles[a.nivel]++;
    else if (a.rotacion) niveles.ROTACION++;
  }
  res.render('inicio', { titulo: 'Inicio', porUbicar: porUbicar.n, ocupacion, pedidos, niveles });
});

module.exports = router;
