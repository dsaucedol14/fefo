/**
 * Recepción de tarimas: RF-01 (ID único y etiqueta QR), RF-02 (uno o más lotes por tarima, RN-06),
 * RF-04 con RN-03 (validar la caducidad al recibir; bajo el mínimo pide autorización de un supervisor).
 */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, uno, tx, siguiente } = require('../db');
const { bitacora, escaneos } = require('../seguridad');
const R = require('../dominio/reglas');
const GS1 = require('../dominio/gs1');
const { idTarima } = require('../dominio/ids');
const inv = require('../servicios/inventario');
const { hoy, texto, entero, lista, fechaValida, fecha } = require('../util');

const router = express.Router();

async function productos(empresaId) {
  return q(`SELECT sku, nombre, requiere_frio FROM producto WHERE empresa_id = ? AND activo = 1 ORDER BY nombre`, [empresaId]);
}

/** Busca un producto por SKU exacto o por un código GS1 escaneado de la caja (RF-03 mínimo). */
router.get('/api/codigo', async (req, res) => {
  const codigo = texto(req.query.c, 200);
  if (!codigo) return res.json({ ok: false });
  const gs1 = GS1.leer(codigo);
  const claves = gs1 ? GS1.clavesProducto(gs1.gtin) : [codigo];
  const p = await uno(`SELECT sku, nombre FROM producto WHERE sku IN (?) AND empresa_id = ? AND activo = 1`,
    [claves, req.usuario.empresa_id]);
  if (!p) return res.json({ ok: false, mensaje: gs1 ? `El GTIN ${gs1.gtin} no está en el catálogo.` : 'Producto no encontrado.' });
  res.json({ ok: true, sku: p.sku, nombre: p.nombre, lote: gs1 && gs1.lote, caducidad: gs1 && gs1.caducidad });
});

router.get('/recepcion', async (req, res) => {
  res.render('recepcion', { titulo: 'Recibir tarima', productos: await productos(req.usuario.empresa_id), renglones: [{}], avisos: [], error: null });
});

function leerRenglones(body) {
  const skus = lista(body.sku);
  const lotes = lista(body.num_lote);
  const cads = lista(body.caducidad);
  const cajas = lista(body.cajas);
  const renglones = [];
  for (let i = 0; i < Math.max(skus.length, lotes.length, cads.length, cajas.length); i++) {
    const r = { sku: texto(skus[i], 14), num_lote: texto(lotes[i], 20), caducidad: texto(cads[i], 10), cajas: texto(cajas[i], 6) };
    if (r.sku || r.num_lote || r.caducidad || r.cajas) renglones.push(r);
  }
  return renglones;
}

/** ¿Quién autoriza? El propio supervisor marcando la casilla, o un supervisor con su usuario y contraseña. */
async function autorizador(req) {
  if (req.usuario.esSupervisor && req.body.autorizo === '1') return req.usuario.id;
  const usuario = (texto(req.body.sup_usuario, 30) || '').toLowerCase();
  if (!usuario) return null;
  const s = await uno(`SELECT id, password_hash FROM usuario WHERE usuario = ? AND activo = 1 AND rol IN ('SUPERVISOR','ADMINISTRACION')`, [usuario]);
  if (s && (await bcrypt.compare(String(req.body.sup_password || ''), s.password_hash))) return s.id;
  return false;
}

router.post('/recepcion', async (req, res) => {
  const alm = req.usuario.almacenId;
  const renglones = leerRenglones(req.body);
  const fechaHoy = hoy();
  const volver = async (error, avisos = []) => res.status(400).render('recepcion', {
    titulo: 'Recibir tarima', productos: await productos(req.usuario.empresa_id), renglones: renglones.length ? renglones : [{}], avisos, error,
  });

  if (!renglones.length) return volver('Captura al menos un lote.');
  const vistos = new Set();
  const avisos = [];
  for (const [i, r] of renglones.entries()) {
    const n = `Renglón ${i + 1}`;
    if (!r.sku) return volver(`${n}: elige el producto.`);
    if (!r.num_lote) return volver(`${n}: escribe el número de lote.`);
    if (!fechaValida(r.caducidad)) return volver(`${n}: la fecha de caducidad no es válida.`);
    r.cajasN = entero(r.cajas);
    if (!r.cajasN || r.cajasN <= 0 || r.cajasN > 9999) return volver(`${n}: las cajas deben ser un número mayor que cero.`);
    const clave = `${r.sku}|${r.num_lote.toUpperCase()}`;
    if (vistos.has(clave)) return volver(`${n}: el lote ${r.num_lote} está repetido en esta tarima; súmalo en un solo renglón.`);
    vistos.add(clave);

    const datos = await inv.datosRecepcion(r.sku, alm);
    if (!datos) return volver(`${n}: el producto ${r.sku} no existe o está inactivo.`);
    r.producto = datos.producto;
    const existente = await uno('SELECT id_lote, fecha_caducidad FROM lote WHERE sku = ? AND num_lote = ?', [r.sku, r.num_lote]);
    if (existente && existente.fecha_caducidad !== r.caducidad) {
      return volver(`${n}: el lote ${r.num_lote} ya está registrado con caducidad ${fecha(existente.fecha_caducidad)}. Revisa la etiqueta.`);
    }
    r.existente = existente;
    const ev = R.evaluarRecepcion({ caducidad: r.caducidad, hoy: fechaHoy, cajas: r.cajasN, demanda: datos.demanda, categoria: datos.producto });
    if (ev.estado === 'RECHAZAR') return volver(`${n}: el lote ${r.num_lote} ya está caducado (${fecha(r.caducidad)}). No se puede recibir.`);
    if (ev.estado === 'AUTORIZAR') {
      r.requiereAutorizacion = true;
      avisos.push(`${datos.producto.nombre}, lote ${r.num_lote}: le quedan ${ev.dias} días y el mínimo para venderlo es ${ev.minimo}.`);
    }
  }

  let autorizo = null;
  if (avisos.length) {
    autorizo = await autorizador(req);
    if (autorizo === false) return volver('El usuario o la contraseña del supervisor no son correctos.', avisos);
    if (!autorizo) return volver(null, avisos);
  }

  const id = await tx(async (con) => {
    const serie = await siguiente(con, `tarima-${req.usuario.empresa_id}`);
    const idT = idTarima(req.usuario.prefijo_id, serie);
    await con.query(`INSERT INTO tarima (id_tarima, almacen_id, estado, fecha_recepcion, recibido_por) VALUES (?, ?, 'ACTIVA', NOW(), ?)`,
      [idT, alm, req.usuario.id]);
    for (const r of renglones) {
      let idLote = r.existente && r.existente.id_lote;
      if (!idLote) {
        idLote = crypto.randomUUID();
        await con.query(`INSERT INTO lote (id_lote, sku, num_lote, fecha_caducidad, fecha_recepcion, autorizado_por) VALUES (?, ?, ?, ?, ?, ?)`,
          [idLote, r.sku, r.num_lote, r.caducidad, fechaHoy, r.requiereAutorizacion ? autorizo : null]);
      }
      await con.query('INSERT INTO tarima_lote (id_tarima, id_lote, cajas) VALUES (?, ?, ?)', [idT, idLote, r.cajasN]);
      await con.query(`INSERT INTO movimiento (almacen_id, tipo, id_tarima, id_lote, cajas, usuario_id, tarea) VALUES (?, 'ENTRADA', ?, ?, ?, ?, ?)`,
        [alm, idT, idLote, r.cajasN, req.usuario.id, req.session.tarea || null]);
    }
    await bitacora(req, {
      accion: 'RECIBIR', entidad: 'tarima', id: idT, escaneos: escaneos(req), resultado: avisos.length ? 'AUTORIZADO' : 'OK',
      despues: { lotes: renglones.map((r) => ({ sku: r.sku, lote: r.num_lote, caducidad: r.caducidad, cajas: r.cajasN })), autorizo },
    }, con);
    return idT;
  });
  req.flash('ok', 'Tarima recibida. Imprime su etiqueta y ubícala escaneando la posición.');
  res.redirect(`/tarimas/${id}`);
});

module.exports = router;
