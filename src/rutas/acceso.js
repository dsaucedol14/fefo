const express = require('express');
const bcrypt = require('bcryptjs');
const { q, uno } = require('../db');
const { requiereSesion, bitacora } = require('../seguridad');
const { texto } = require('../util');

const router = express.Router();

// RNF-08: tras 5 intentos fallidos, el 6.º se bloquea durante 5 minutos (por usuario y dirección)
const intentos = new Map();
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 5 * 60 * 1000;

function bloqueado(clave) {
  const r = intentos.get(clave);
  return r && r.n >= MAX_INTENTOS && Date.now() - r.ultimo < BLOQUEO_MS;
}

function fallo(clave) {
  const r = intentos.get(clave);
  const vencido = !r || Date.now() - r.ultimo > BLOQUEO_MS;
  intentos.set(clave, { n: vencido ? 1 : r.n + 1, ultimo: Date.now() });
}

router.get('/login', (req, res) => {
  if (req.usuario) return res.redirect('/');
  res.render('login', { titulo: 'Iniciar sesión', usuarioEscrito: '' });
});

router.post('/login', async (req, res) => {
  const usuario = (texto(req.body.usuario, 30) || '').toLowerCase();
  const clave = `${usuario}|${req.ip}`;
  const volver = (mensaje) => res.status(401).render('login', { titulo: 'Iniciar sesión', usuarioEscrito: usuario, error: mensaje });

  if (bloqueado(clave)) {
    await bitacora(req, { accion: 'ACCESO_BLOQUEADO', entidad: 'sesion', id: usuario, resultado: 'RECHAZADO' });
    return volver('Demasiados intentos. Espera 5 minutos e inténtalo de nuevo.');
  }
  const u = await uno('SELECT id, password_hash FROM usuario WHERE usuario = ? AND activo = 1', [usuario]);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    fallo(clave);
    return volver('Usuario o contraseña incorrectos.');
  }
  intentos.delete(clave);
  const destino = req.session.volverA && req.session.volverA.startsWith('/') ? req.session.volverA : '/';
  await new Promise((ok, mal) => req.session.regenerate((e) => (e ? mal(e) : ok())));
  req.session.usuarioId = u.id;
  req.usuario = { id: u.id };
  await bitacora(req, { accion: 'ENTRAR', entidad: 'sesion', id: u.id, resultado: 'OK' });
  res.redirect(destino);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/aviso-privacidad', requiereSesion, (req, res) => {
  res.render('aviso', { titulo: 'Aviso de privacidad' });
});

router.post('/aviso-privacidad', requiereSesion, async (req, res) => {
  if (!req.usuario.aviso_aceptado_en) {
    await q('UPDATE usuario SET aviso_aceptado_en = NOW() WHERE id = ?', [req.usuario.id]);
    await bitacora(req, { accion: 'ACEPTAR_AVISO', entidad: 'usuario', id: req.usuario.id, resultado: 'OK' });
  }
  res.redirect('/');
});

router.get('/cuenta', requiereSesion, (req, res) => {
  res.render('cuenta', { titulo: 'Mi cuenta' });
});

router.post('/cuenta/password', requiereSesion, async (req, res) => {
  const { actual, nueva, confirmacion } = req.body;
  const u = await uno('SELECT password_hash FROM usuario WHERE id = ?', [req.usuario.id]);
  if (!(await bcrypt.compare(String(actual || ''), u.password_hash))) {
    req.flash('error', 'La contraseña actual no es correcta.');
  } else if (!nueva || String(nueva).length < 8) {
    req.flash('error', 'La nueva contraseña debe tener al menos 8 caracteres.');
  } else if (nueva !== confirmacion) {
    req.flash('error', 'La confirmación no coincide.');
  } else {
    await q('UPDATE usuario SET password_hash = ? WHERE id = ?', [await bcrypt.hash(nueva, 10), req.usuario.id]);
    await bitacora(req, { accion: 'CAMBIAR_PASSWORD', entidad: 'usuario', id: req.usuario.id, resultado: 'OK' });
    req.flash('ok', 'Contraseña actualizada.');
  }
  res.redirect('/cuenta');
});

/**
 * Tarea de evaluación (Sección III.F): el observador fija el código de la tarea antes de que el operador la haga;
 * todo lo que se registre queda ligado a ese código en la bitácora y en los movimientos.
 */
router.post('/tarea', requiereSesion, async (req, res) => {
  const codigo = texto(req.body.tarea, 30);
  const anterior = req.session.tarea || null;
  if (codigo && /^[\w.-]+$/.test(codigo)) req.session.tarea = codigo.toUpperCase();
  else delete req.session.tarea;
  await bitacora(req, { accion: req.session.tarea ? 'INICIAR_TAREA' : 'TERMINAR_TAREA', entidad: 'tarea',
    id: req.session.tarea || anterior, resultado: 'OK' });
  const volver = texto(req.body.volver, 200);
  res.redirect(volver && volver.startsWith('/') ? volver : '/');
});

module.exports = router;
