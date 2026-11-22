/**
 * Asigna contraseña a usuarios (RNF-08): bcrypt, mínimo 8 caracteres. Sirve para la primera puesta en marcha,
 * porque el catálogo de P3 crea los usuarios con el marcador «bcrypt$pendiente».
 *
 *   npm run usuarios -- <id_usuario> <contraseña>
 *   npm run usuarios -- --pendientes <contraseña>     (todos los que aún no tienen contraseña)
 */
import bcrypt from 'bcryptjs';
import { pool, tx } from '../bd.js';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.log('Uso: npm run usuarios -- <id_usuario> <contraseña>   |   npm run usuarios -- --pendientes <contraseña>');
  process.exit(1);
}
if (b.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres (RNF-08).');
  process.exit(1);
}
const hash = await bcrypt.hash(b, 10);
const r = await tx('administracion', (con) => a === '--pendientes'
  ? con.query(`UPDATE usuario SET hash_contrasena = $1 WHERE hash_contrasena = 'bcrypt$pendiente'`, [hash])
  : con.query(`UPDATE usuario SET hash_contrasena = $1, intentos_fallidos = 0 WHERE id_usuario = $2`, [hash, a.toLowerCase()]));
console.log(r.rowCount ? `Contraseña asignada a ${r.rowCount} usuario(s).` : 'No se encontró el usuario.');
await pool.end();
