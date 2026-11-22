/** Parámetros (CU-12, RNF-11): umbrales U(c) por categoría, parámetros globales y usuarios con su rol (RF-21). */
import bcrypt from 'bcryptjs';
import { q, tx, uno } from '../../bd.js';
import { ErrorNegocio, traducir } from '../../errores.js';
import type { Rol, Usuario } from '../../seguridad/sesion.js';

export const categorias = () => q(`SELECT id_categoria, nombre, conservacion, vu_dias, vmr_dias, tr_dias, ms_dias, umbral_dias FROM categoria ORDER BY nombre`);

export async function actualizarCategoria(id: number, v: { vu_dias: number; vmr_dias: number; tr_dias: number; ms_dias: number }, usuario: Usuario) {
  try {
    return await tx(usuario.id_usuario, async (con) => {
      const [c] = await q(`UPDATE categoria SET vu_dias = $2, vmr_dias = $3, tr_dias = $4, ms_dias = $5 WHERE id_categoria = $1
                           RETURNING id_categoria, nombre, conservacion, vu_dias, vmr_dias, tr_dias, ms_dias, umbral_dias`,
        [id, v.vu_dias, v.vmr_dias, v.tr_dias, v.ms_dias], con);
      if (!c) throw new ErrorNegocio('categoria_inexistente', 'Esa categoría no existe.', 404);
      return c;
    });
  } catch (e) {
    throw traducir(e) ?? e;
  }
}

export const parametros = () => q(`SELECT clave, valor, descripcion FROM parametro ORDER BY clave`);

export async function actualizarParametro(clave: string, valor: number, usuario: Usuario) {
  return tx(usuario.id_usuario, async (con) => {
    const [p] = await q(`UPDATE parametro SET valor = $2 WHERE clave = $1 RETURNING clave, valor, descripcion`, [clave, valor], con);
    if (!p) throw new ErrorNegocio('parametro_inexistente', 'Ese parámetro no existe.', 404);
    return p;
  });
}

export const productos = (gtin?: string) => gtin
  ? q(`SELECT sku, nombre, requiere_frio FROM producto WHERE activo AND sku = ANY($1)`, [gtin.startsWith('0') ? [gtin, gtin.slice(1)] : [gtin]])
  : q(`SELECT p.sku, p.nombre, p.requiere_frio, c.nombre AS categoria FROM producto p JOIN categoria c USING (id_categoria) WHERE p.activo ORDER BY p.nombre`);

export const usuarios = () => q(`SELECT id_usuario, nombre, rol, intentos_fallidos, bloqueado, activo, aviso_aceptado_en::text FROM usuario ORDER BY id_usuario`);

export async function crearUsuario(u: { id_usuario: string; nombre: string; rol: Rol; contrasena: string }, quien: Usuario) {
  if (await uno(`SELECT 1 FROM usuario WHERE id_usuario = $1`, [u.id_usuario])) throw new ErrorNegocio('usuario_existe', 'Ese usuario ya existe.', 409);
  const hash = await bcrypt.hash(u.contrasena, 10);
  await tx(quien.id_usuario, (con) => con.query(`INSERT INTO usuario (id_usuario, nombre, rol, hash_contrasena) VALUES ($1, $2, $3, $4)`,
    [u.id_usuario, u.nombre, u.rol, hash]));
}

/** Cambia rol o estado, desbloquea (intentos a 0) o asigna nueva contraseña. */
export async function actualizarUsuario(id: string, c: { rol?: Rol; activo?: boolean; desbloquear?: boolean; contrasena?: string }, quien: Usuario) {
  if (id === quien.id_usuario && (c.activo === false || (c.rol && c.rol !== quien.rol))) {
    throw new ErrorNegocio('propio', 'No puedes cambiar tu propio rol ni desactivarte.', 409);
  }
  const hash = c.contrasena ? await bcrypt.hash(c.contrasena, 10) : null;
  await tx(quien.id_usuario, async (con) => {
    const r = await con.query(
      `UPDATE usuario SET rol = COALESCE($2, rol), activo = COALESCE($3, activo),
              intentos_fallidos = CASE WHEN $4 THEN 0 ELSE intentos_fallidos END, hash_contrasena = COALESCE($5, hash_contrasena)
        WHERE id_usuario = $1`, [id, c.rol ?? null, c.activo ?? null, c.desbloquear === true, hash]);
    if (!r.rowCount) throw new ErrorNegocio('usuario_inexistente', 'Ese usuario no existe.', 404);
    if (c.activo === false || hash) await con.query(`DELETE FROM sesion WHERE id_usuario = $1`, [id]);
  });
}
