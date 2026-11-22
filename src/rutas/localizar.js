/**
 * RF-09: localizar un lote o producto por código, nombre o escaneo; muestra zona, fila o pasillo, profundidad y las
 * tarimas que lo bloquean. Si se escanea una tarima o una posición, abre directamente su ficha.
 */
const express = require('express');
const { q, uno } = require('../db');
const { bitacora, escaneos } = require('../seguridad');
const inv = require('../servicios/inventario');
const R = require('../dominio/reglas');
const GS1 = require('../dominio/gs1');
const { hoy, diasEntre, texto } = require('../util');

const router = express.Router();

router.get('/localizar', async (req, res) => {
  const alm = req.usuario.almacenId;
  const entrada = texto(req.query.q, 200);
  if (!entrada) return res.render('localizar', { titulo: 'Localizar', entrada: '', resultados: null });

  const exacto = entrada.replace(/\s+/g, '').toUpperCase();
  const tarima = await uno('SELECT id_tarima FROM tarima WHERE id_tarima = ? AND almacen_id = ?', [exacto, alm]);
  const posicion = tarima ? null
    : await uno(`SELECT t.id_tarima FROM tarima t WHERE t.id_posicion = ? AND t.estado = 'ACTIVA' AND t.almacen_id = ?`, [exacto, alm]);
  const directo = tarima || posicion;
  const registrar = (resultado, n) => bitacora(req, { accion: 'LOCALIZAR', entidad: 'busqueda', id: entrada.slice(0, 40),
    escaneos: escaneos(req) ?? (Number(req.query.escaneos) || null), resultado, detalle: n != null ? `${n} resultados` : null });
  if (directo) {
    await registrar('TARIMA', 1);
    return res.redirect(`/tarimas/${directo.id_tarima}`);
  }

  // Código GS1 de una caja: se busca su lote; si no trae lote, todo el producto
  const gs1 = GS1.leer(entrada);
  let where;
  let params;
  if (gs1) {
    where = gs1.lote ? 'l.sku IN (?) AND l.num_lote = ?' : 'l.sku IN (?)';
    params = gs1.lote ? [GS1.clavesProducto(gs1.gtin), gs1.lote] : [GS1.clavesProducto(gs1.gtin)];
  } else {
    const like = `%${entrada.replace(/[\\%_]/g, '\\$&')}%`;
    where = '(l.num_lote = ? OR l.sku = ? OR pr.nombre LIKE ?)';
    params = [entrada, entrada, like];
  }
  const filas = await q(
    `SELECT l.id_lote, l.num_lote, l.sku, l.fecha_caducidad, l.caducidad_efectiva, l.fecha_recepcion, pr.nombre AS producto,
            tl.id_tarima, tl.cajas, t.id_posicion, p.zona, p.tipo, p.fila, p.profundidad
     FROM lote l JOIN producto pr ON pr.sku = l.sku
     JOIN tarima_lote tl ON tl.id_lote = l.id_lote AND tl.cajas > 0
     JOIN tarima t ON t.id_tarima = tl.id_tarima AND t.estado = 'ACTIVA' AND t.almacen_id = ?
     LEFT JOIN posicion p ON p.id_posicion = t.id_posicion
     WHERE ${where}
     ORDER BY pr.nombre, COALESCE(l.caducidad_efectiva, l.fecha_caducidad), l.fecha_recepcion, p.profundidad
     LIMIT 200`, [alm, ...params]);

  const mapa = await inv.mapaFilas(alm);
  const fecha = hoy();
  // El primer lote elegible de cada producto es su prioridad FEFO
  const fefoPorSku = new Map();
  for (const f of filas) {
    f.d = diasEntre(fecha, R.caducidadDe(f));
    f.bloqueadores = inv.bloqueadores(mapa, f);
    if (!fefoPorSku.has(f.sku) && f.id_posicion && !R.caducado(f, fecha)) fefoPorSku.set(f.sku, f.id_lote);
  }
  for (const f of filas) f.esFefo = fefoPorSku.get(f.sku) === f.id_lote;
  await registrar(filas.length ? 'ENCONTRADO' : 'SIN_RESULTADOS', filas.length);
  res.render('localizar', { titulo: 'Localizar', entrada, resultados: filas });
});

module.exports = router;
