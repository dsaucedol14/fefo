const crypto = require('crypto');
const config = require('./config');
const { q } = require('./db');

/** Encabezados básicos de seguridad. La cámara se permite solo para este sitio (escaneo, RES-03). */
function encabezados(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'",
  });
  next();
}

/** Mensajes de una sola vez entre redirecciones. */
function flash(req, res, next) {
  res.locals.mensajes = req.session.flash || {};
  delete req.session.flash;
  req.flash = (tipo, texto) => {
    req.session.flash = req.session.flash || {};
    req.session.flash[tipo] = texto;
  };
  next();
}

/** Token CSRF por sesión; se exige en todo POST (campo _csrf o encabezado x-csrf-token). */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  next();
}

function validarCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const esperado = req.session.csrf;
  if (!token || !esperado || token.length !== esperado.length
      || !crypto.timingSafeEqual(Buffer.from(String(token)), Buffer.from(esperado))) {
    return res.status(403).render('error', { titulo: 'Sesión vencida', mensaje: 'El formulario caducó. Regresa, recarga la página e inténtalo de nuevo.' });
  }
  next();
}

const ROLES = { ALMACENISTA: 'Almacenista', SUPERVISOR: 'Supervisor', ADMINISTRACION: 'Administración' };

/** Carga el usuario de la sesión (siempre desde la base, para que una baja o cambio de rol aplique al momento). */
async function cargarUsuario(req, res, next) {
  res.locals.usuario = null;
  if (req.session.usuarioId) {
    const u = (await q(
      `SELECT u.id, u.usuario, u.nombre, u.rol, u.empresa_id, u.aviso_aceptado_en, e.nombre AS empresa, e.prefijo_id
       FROM usuario u JOIN empresa e ON e.id = u.empresa_id WHERE u.id = ? AND u.activo = 1`, [req.session.usuarioId]))[0];
    if (u) {
      u.esSupervisor = u.rol === 'SUPERVISOR' || u.rol === 'ADMINISTRACION';
      u.esAdmin = u.rol === 'ADMINISTRACION';
      u.nombreRol = ROLES[u.rol];
      // Prototipo: una empresa y un almacén piloto (Tabla VII); el modelo ya separa por almacén
      u.almacenId = req.session.almacenId || 1;
      req.usuario = u;
      res.locals.usuario = u;
    } else {
      delete req.session.usuarioId;
    }
  }
  res.locals.tarea = req.session.tarea || null;
  next();
}

function requiereSesion(req, res, next) {
  if (req.usuario) return next();
  if (req.method === 'GET') req.session.volverA = req.originalUrl;
  res.redirect('/login');
}

/** RNF-09: el aviso de privacidad se muestra y se acepta en el primer ingreso. */
function requiereAviso(req, res, next) {
  if (req.usuario.aviso_aceptado_en) return next();
  res.redirect('/aviso-privacidad');
}

function prohibido(res, mensaje) {
  return res.status(403).render('error', { titulo: 'Sin permiso', mensaje });
}

function requiereSupervisor(req, res, next) {
  if (req.usuario && req.usuario.esSupervisor) return next();
  prohibido(res, 'Esta función es para el supervisor.');
}

function requiereAdmin(req, res, next) {
  if (req.usuario && req.usuario.esAdmin) return next();
  prohibido(res, 'Esta función es para administración.');
}

/**
 * Bitácora de evaluación (RF-20, subconjunto del prototipo): tarea, modalidad, fecha y hora, usuario, escaneos,
 * resultado y valores anterior y nuevo. Se escribe dentro de la misma transacción que la operación cuando se pasa `con`.
 */
async function bitacora(req, datos, con) {
  const sql = `INSERT INTO bitacora (usuario_id, tarea, accion, entidad, id_registro, escaneos, resultado,
      valor_anterior, valor_nuevo, detalle, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    req.usuario ? req.usuario.id : null, (req.session && req.session.tarea) || null,
    datos.accion, datos.entidad, datos.id != null ? String(datos.id) : null,
    Number.isInteger(datos.escaneos) ? datos.escaneos : null, datos.resultado || null,
    datos.antes ? JSON.stringify(datos.antes) : null, datos.despues ? JSON.stringify(datos.despues) : null,
    datos.detalle ? String(datos.detalle).slice(0, 300) : null, config.version,
  ];
  if (con) return con.query(sql, params);
  try {
    await q(sql, params);
  } catch (e) {
    console.error('No se pudo escribir en la bitácora:', e.message);
  }
}

/** Escaneos realizados en el formulario (los cuenta public/js/escaner.js). */
function escaneos(req) {
  const n = Number(req.body && req.body.escaneos);
  return Number.isInteger(n) && n >= 0 && n < 1000 ? n : null;
}

module.exports = {
  encabezados, flash, csrf, validarCsrf, cargarUsuario, requiereSesion, requiereAviso,
  requiereSupervisor, requiereAdmin, prohibido, bitacora, escaneos, ROLES,
};
