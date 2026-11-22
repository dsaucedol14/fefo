/**
 * Administración: usuarios y roles (RF-21), parámetros U(c) por categoría (RN-07), catálogo de productos y
 * bitácora de evaluación con exportación CSV para el análisis de P4.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, uno, pool } = require('../db');
const { bitacora, requiereAdmin, ROLES } = require('../seguridad');
const R = require('../dominio/reglas');
const config = require('../config');
const { texto, entero, numero } = require('../util');

const router = express.Router();

// ---------- Usuarios (solo administración) ----------

router.get('/usuarios', requiereAdmin, async (req, res) => {
  const usuarios = await q('SELECT id, usuario, nombre, rol, activo, aviso_aceptado_en, creado_en FROM usuario WHERE empresa_id = ? ORDER BY activo DESC, nombre',
    [req.usuario.empresa_id]);
  res.render('admin/usuarios', { titulo: 'Usuarios', usuarios, ROLES, error: null, form: {} });
});

router.post('/usuarios', requiereAdmin, async (req, res) => {
  const form = { usuario: (texto(req.body.usuario, 30) || '').toLowerCase(), nombre: texto(req.body.nombre, 120), rol: req.body.rol };
  const password = String(req.body.password || '');
  const volver = async (error) => res.status(400).render('admin/usuarios', { titulo: 'Usuarios',
    usuarios: await q('SELECT id, usuario, nombre, rol, activo, aviso_aceptado_en, creado_en FROM usuario WHERE empresa_id = ? ORDER BY activo DESC, nombre', [req.usuario.empresa_id]),
    ROLES, error, form });
  if (!/^[a-z0-9._-]{3,30}$/.test(form.usuario)) return volver('El usuario debe tener de 3 a 30 letras minúsculas, números, punto o guion.');
  if (!form.nombre) return volver('Escribe el nombre.');
  if (!ROLES[form.rol]) return volver('Elige el rol.');
  if (password.length < 8) return volver('La contraseña debe tener al menos 8 caracteres.');
  if (await uno('SELECT id FROM usuario WHERE usuario = ?', [form.usuario])) return volver('Ese usuario ya existe.');
  const [r] = await pool.query(
    'INSERT INTO usuario (empresa_id, usuario, nombre, password_hash, rol) VALUES (?, ?, ?, ?, ?)',
    [req.usuario.empresa_id, form.usuario, form.nombre, await bcrypt.hash(password, 10), form.rol]);
  await bitacora(req, { accion: 'CREAR_USUARIO', entidad: 'usuario', id: r.insertId, resultado: 'OK', despues: { usuario: form.usuario, rol: form.rol } });
  req.flash('ok', `Usuario ${form.usuario} creado.`);
  res.redirect('/admin/usuarios');
});

router.post('/usuarios/:id', requiereAdmin, async (req, res) => {
  const u = await uno('SELECT * FROM usuario WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
  if (!u) return res.redirect('/admin/usuarios');
  const rol = ROLES[req.body.rol] ? req.body.rol : u.rol;
  const activo = req.body.activo === '1' ? 1 : 0;
  if (u.id === req.usuario.id && (rol !== 'ADMINISTRACION' || !activo)) {
    req.flash('error', 'No puedes quitarte a ti mismo el rol de administración ni desactivarte.');
    return res.redirect('/admin/usuarios');
  }
  const password = String(req.body.password || '');
  if (password && password.length < 8) {
    req.flash('error', 'La contraseña nueva debe tener al menos 8 caracteres.');
    return res.redirect('/admin/usuarios');
  }
  await q('UPDATE usuario SET rol = ?, activo = ? WHERE id = ?', [rol, activo, u.id]);
  if (password) await q('UPDATE usuario SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 10), u.id]);
  await bitacora(req, { accion: 'EDITAR_USUARIO', entidad: 'usuario', id: u.id, resultado: 'OK',
    antes: { rol: u.rol, activo: u.activo }, despues: { rol, activo, password: password ? 'cambiada' : undefined } });
  req.flash('ok', `Usuario ${u.usuario} actualizado.`);
  res.redirect('/admin/usuarios');
});

// ---------- Categorías y umbral U(c) ----------

router.get('/categorias', async (req, res) => {
  const categorias = await q(`SELECT c.*, (SELECT COUNT(*) FROM producto p WHERE p.categoria_id = c.id) AS productos
                              FROM categoria c WHERE empresa_id = ? ORDER BY nombre`, [req.usuario.empresa_id]);
  for (const c of categorias) Object.assign(c, R.umbral(c, config.umbralOmision));
  res.render('admin/categorias', { titulo: 'Categorías y umbrales', categorias, omision: config.umbralOmision });
});

const dias = (v) => {
  const n = entero(v);
  return n === null ? null : Math.max(0, Math.min(n, 3650));
};

router.post('/categorias', async (req, res) => {
  const nombre = texto(req.body.nombre, 60);
  const conservacion = ['AMBIENTE', 'REFRIGERADO', 'CONGELADO'].includes(req.body.conservacion) ? req.body.conservacion : 'AMBIENTE';
  const id = entero(req.body.id);
  const valores = [dias(req.body.vu_dias), dias(req.body.vmr_dias), dias(req.body.tr_dias), dias(req.body.ms_dias)];
  if (!nombre) {
    req.flash('error', 'Escribe el nombre de la categoría.');
    return res.redirect('/admin/categorias');
  }
  if (id) {
    const antes = await uno('SELECT * FROM categoria WHERE id = ? AND empresa_id = ?', [id, req.usuario.empresa_id]);
    if (!antes) return res.redirect('/admin/categorias');
    await q('UPDATE categoria SET nombre = ?, conservacion = ?, vu_dias = ?, vmr_dias = ?, tr_dias = ?, ms_dias = ? WHERE id = ?',
      [nombre, conservacion, ...valores, id]);
    await bitacora(req, { accion: 'EDITAR_UMBRAL', entidad: 'categoria', id, resultado: 'OK',
      antes: { vu: antes.vu_dias, vmr: antes.vmr_dias, tr: antes.tr_dias, ms: antes.ms_dias },
      despues: { vu: valores[0], vmr: valores[1], tr: valores[2], ms: valores[3] } });
    req.flash('ok', `Categoría ${nombre} actualizada; las alertas ya usan los nuevos parámetros.`);
  } else {
    try {
      await q('INSERT INTO categoria (empresa_id, nombre, conservacion, vu_dias, vmr_dias, tr_dias, ms_dias) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.usuario.empresa_id, nombre, conservacion, ...valores]);
      req.flash('ok', `Categoría ${nombre} creada.`);
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      req.flash('error', 'Ya existe una categoría con ese nombre.');
    }
  }
  res.redirect('/admin/categorias');
});

// ---------- Productos ----------

router.get('/productos', async (req, res) => {
  const productos = await q(`SELECT p.*, c.nombre AS categoria FROM producto p JOIN categoria c ON c.id = p.categoria_id
                             WHERE p.empresa_id = ? ORDER BY p.activo DESC, p.nombre`, [req.usuario.empresa_id]);
  const categorias = await q('SELECT id, nombre FROM categoria WHERE empresa_id = ? ORDER BY nombre', [req.usuario.empresa_id]);
  res.render('admin/productos', { titulo: 'Productos', productos, categorias });
});

router.post('/productos', async (req, res) => {
  const sku = (texto(req.body.sku, 14) || '').replace(/\s+/g, '');
  const nombre = texto(req.body.nombre, 120);
  const categoria = await uno('SELECT id FROM categoria WHERE id = ? AND empresa_id = ?', [entero(req.body.categoria_id), req.usuario.empresa_id]);
  const datos = [nombre, categoria && categoria.id, dias(req.body.vida_util_dias), req.body.requiere_frio === '1' ? 1 : 0,
    Math.max(0, numero(req.body.costo_caja) || 0), req.body.activo === '0' ? 0 : 1];
  if (!/^[A-Za-z0-9-]{1,14}$/.test(sku) || !nombre || !categoria) {
    req.flash('error', 'Captura SKU (hasta 14 caracteres), nombre y categoría.');
    return res.redirect('/admin/productos');
  }
  const antes = await uno('SELECT * FROM producto WHERE sku = ?', [sku]);
  if (antes && antes.empresa_id !== req.usuario.empresa_id) {
    req.flash('error', 'Ese SKU pertenece a otra empresa.');
    return res.redirect('/admin/productos');
  }
  if (antes) {
    await q('UPDATE producto SET nombre = ?, categoria_id = ?, vida_util_dias = ?, requiere_frio = ?, costo_caja = ?, activo = ? WHERE sku = ?', [...datos, sku]);
  } else {
    await q('INSERT INTO producto (nombre, categoria_id, vida_util_dias, requiere_frio, costo_caja, activo, sku, empresa_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [...datos, sku, req.usuario.empresa_id]);
  }
  await bitacora(req, { accion: antes ? 'EDITAR_PRODUCTO' : 'CREAR_PRODUCTO', entidad: 'producto', id: sku, resultado: 'OK' });
  req.flash('ok', `Producto ${sku} guardado.`);
  res.redirect('/admin/productos');
});

// ---------- Bitácora y exportes ----------

router.get('/bitacora', async (req, res) => {
  const tarea = texto(req.query.tarea, 30);
  const filas = await q(
    `SELECT b.*, u.usuario FROM bitacora b LEFT JOIN usuario u ON u.id = b.usuario_id
     ${tarea ? 'WHERE b.tarea = ?' : ''} ORDER BY b.id DESC LIMIT 300`, tarea ? [tarea] : []);
  const tareas = await q('SELECT tarea, COUNT(*) AS n, MIN(fecha_hora) AS inicio, MAX(fecha_hora) AS fin FROM bitacora WHERE tarea IS NOT NULL GROUP BY tarea ORDER BY MIN(id) DESC LIMIT 100');
  res.render('admin/bitacora', { titulo: 'Bitácora', filas, tareas, tarea });
});

function csv(res, nombre, columnas, filas) {
  const celda = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send('﻿' + [columnas.join(','), ...filas.map((f) => columnas.map((c) => celda(f[c])).join(','))].join('\r\n'));
}

// El usuario se exporta solo con su código interno (id), sin nombre: datos anonimizados para el análisis
router.get('/bitacora.csv', async (req, res) => {
  const filas = await q('SELECT * FROM bitacora ORDER BY id');
  csv(res, 'bitacora.csv', ['id', 'fecha_hora', 'usuario_id', 'tarea', 'modalidad', 'accion', 'entidad', 'id_registro',
    'escaneos', 'resultado', 'valor_anterior', 'valor_nuevo', 'detalle', 'version'], filas);
});

router.get('/movimientos.csv', async (req, res) => {
  const filas = await q(
    `SELECT m.id, m.fecha_hora, m.tipo, m.id_tarima, l.sku, l.num_lote, m.cajas, m.pos_origen, m.pos_destino,
            lp.num_lote AS lote_propuesto, m.conforme_fefo, m.motivo_excepcion, m.justificacion, m.usuario_id, m.tarea, m.origen_dato
     FROM movimiento m LEFT JOIN lote l ON l.id_lote = m.id_lote LEFT JOIN lote lp ON lp.id_lote = m.lote_propuesto
     WHERE m.almacen_id = ? ORDER BY m.id`, [req.usuario.almacenId]);
  csv(res, 'movimientos.csv', ['id', 'fecha_hora', 'tipo', 'id_tarima', 'sku', 'num_lote', 'cajas', 'pos_origen', 'pos_destino',
    'lote_propuesto', 'conforme_fefo', 'motivo_excepcion', 'justificacion', 'usuario_id', 'tarea', 'origen_dato'], filas);
});

module.exports = router;
