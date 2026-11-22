/**
 * Crea (o recrea) la base con el modelo físico de P3 (01, 02) y la extensión del prototipo (06), y fija la
 * contraseña del rol app_fefo. Con --clave asigna esa contraseña a los usuarios del catálogo que aún tienen el
 * marcador «bcrypt$pendiente» (desarrollo y maqueta [L]).
 *
 *   npm run bd:preparar -- --reiniciar [--clave almacen2026]
 */
import { config } from '../config.js';
import { prepararBase } from './base.js';

const i = process.argv.indexOf('--clave');
if (!process.argv.includes('--reiniciar')) {
  console.log(`Esto BORRA la base «${config.nombreBase}» y la vuelve a crear solo con el catálogo de P3.`);
  console.log('Para confirmarlo:  npm run bd:preparar -- --reiniciar [--clave <contraseña de los usuarios>]');
  process.exit(1);
}
prepararBase(config.nombreBase, i >= 0 ? process.argv[i + 1] : undefined)
  .then(() => console.log(`Base «${config.nombreBase}» lista: 01_esquema, 02_catalogo y 06_extension_prototipo.`))
  .catch((e) => { console.error(e.message); process.exit(1); });
