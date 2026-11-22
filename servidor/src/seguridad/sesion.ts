/**
 * Seguridad (RNF-08, RNF-09, RF-21): contraseñas con bcrypt, bloqueo al 5.º intento fallido (columna calculada
 * usuario.bloqueado de P3), sesión en cookie HttpOnly + SameSite=Strict y autorización por rol.
 * Solo se guardan nombre, usuario y rol de cada persona.
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { q, uno } from '../bd.js';
import { config } from '../config.js';
import { ErrorNegocio } from '../errores.js';

export type Rol = 'almacenista' | 'supervisor' | 'administracion';
export interface Usuario { id_usuario: string; nombre: string; rol: Rol; aviso_aceptado_en: string | null }

declare module 'fastify' {
  interface FastifyRequest { usuario?: Usuario }
}

export const COOKIE = 'fefo_sesion';
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function iniciarSesion(idUsuario: string, contrasena: string): Promise<{ token: string; usuario: Usuario }> {
  const u = await uno<{ id_usuario: string; hash_contrasena: string; bloqueado: boolean; activo: boolean }>(
    `SELECT id_usuario, hash_contrasena, bloqueado, activo FROM usuario WHERE id_usuario = $1`, [idUsuario]);
  const falla = new ErrorNegocio('credenciales', 'Usuario o contraseña incorrectos.', 401);
  if (!u || !u.activo) throw falla;
  if (u.bloqueado) throw new ErrorNegocio('bloqueado', 'La cuenta está bloqueada por intentos fallidos. Pide al supervisor que la desbloquee.', 423);
  const valida = u.hash_contrasena.startsWith('$2') && await bcrypt.compare(contrasena, u.hash_contrasena);
  if (!valida) {
    const r = await uno<{ bloqueado: boolean }>(
      `UPDATE usuario SET intentos_fallidos = intentos_fallidos + 1 WHERE id_usuario = $1 RETURNING bloqueado`, [idUsuario]);
    if (r?.bloqueado) throw new ErrorNegocio('bloqueado', 'La cuenta quedó bloqueada tras 5 intentos fallidos.', 423);
    throw falla;
  }
  await q(`UPDATE usuario SET intentos_fallidos = 0 WHERE id_usuario = $1 AND intentos_fallidos <> 0`, [idUsuario]);
  const token = randomBytes(32).toString('base64url');
  await q(`DELETE FROM sesion WHERE expira < now()`);
  await q(`INSERT INTO sesion (id_sesion, id_usuario, expira) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), idUsuario, config.horasSesion]);
  const usuario = (await usuarioDeSesion(token))!;
  return { token, usuario };
}

export async function usuarioDeSesion(token: string | undefined): Promise<Usuario | null> {
  if (!token) return null;
  return uno<Usuario>(
    `UPDATE sesion s SET ultima_actividad = now(), expira = now() + make_interval(hours => $2)
       FROM usuario u
      WHERE s.id_sesion = $1 AND s.expira > now() AND u.id_usuario = s.id_usuario AND u.activo AND NOT u.bloqueado
     RETURNING u.id_usuario, u.nombre, u.rol, u.aviso_aceptado_en::text`, [hashToken(token), config.horasSesion]);
}

export async function cerrarSesion(token: string | undefined): Promise<void> {
  if (token) await q(`DELETE FROM sesion WHERE id_sesion = $1`, [hashToken(token)]);
}

export function opcionesCookie() {
  return { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: config.cookieSegura, maxAge: config.horasSesion * 3600 };
}

/** preHandler: exige sesión válida y, salvo para aceptarlo, el aviso de privacidad aceptado. */
export async function autenticar(req: FastifyRequest, rep: FastifyReply) {
  const u = await usuarioDeSesion(req.cookies[COOKIE]);
  if (!u) return rep.code(401).send({ codigo: 'sin_sesion', mensaje: 'Inicia sesión.' });
  req.usuario = u;
  if (!u.aviso_aceptado_en && !req.url.startsWith('/api/aviso') && !req.url.startsWith('/api/sesiones')) {
    return rep.code(403).send({ codigo: 'aviso_pendiente', mensaje: 'Acepta el aviso de privacidad para continuar.' });
  }
}

const NIVEL: Record<Rol, number> = { almacenista: 1, supervisor: 2, administracion: 3 };

/** preHandler: exige al menos el rol indicado (administración ⊃ supervisor ⊃ almacenista). */
export function autorizar(minimo: Rol) {
  return async (req: FastifyRequest, rep: FastifyReply) => {
    if (!req.usuario || NIVEL[req.usuario.rol] < NIVEL[minimo]) {
      return rep.code(403).send({ codigo: 'sin_permiso', mensaje: 'Tu rol no permite esta operación.' });
    }
  };
}

/** Verifica las credenciales de un supervisor que autoriza en el teléfono de otro usuario (RN-03). */
export async function verificarSupervisor(idUsuario: string, contrasena: string): Promise<string> {
  const u = await uno<{ id_usuario: string; hash_contrasena: string; rol: Rol; bloqueado: boolean }>(
    `SELECT id_usuario, hash_contrasena, rol, bloqueado FROM usuario WHERE id_usuario = $1 AND activo`, [idUsuario]);
  if (!u || NIVEL[u.rol] < NIVEL.supervisor || u.bloqueado || !u.hash_contrasena.startsWith('$2')
      || !(await bcrypt.compare(contrasena, u.hash_contrasena))) {
    throw new ErrorNegocio('autorizacion_invalida', 'El usuario o la contraseña del supervisor no son correctos.', 403);
  }
  return u.id_usuario;
}
