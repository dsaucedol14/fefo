/** Configuración por variables de entorno (ver despliegue/.env.example). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const paquete = JSON.parse(readFileSync(path.join(aqui, '..', 'package.json'), 'utf8')) as { version: string };

export const config = {
  version: paquete.version,
  puerto: Number(process.env.PORT ?? 3000),
  anfitrion: process.env.HOST ?? '0.0.0.0',
  // La aplicación se conecta como app_fefo: no puede modificar ni borrar movimientos ni bitácora (RNF-08)
  urlBase: process.env.DATABASE_URL ?? 'postgres://app_fefo:app-fefo-dev@localhost:5433/fefo',
  // Solo para preparar la base y cargar el caso simulado (superusuario)
  urlAdmin: process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:fefo-dev@localhost:5433/postgres',
  nombreBase: process.env.DATABASE_NAME ?? 'fefo',
  claveApp: process.env.APP_DB_PASSWORD ?? 'app-fefo-dev',
  // Carpeta del cliente compilado (cliente/dist); el servidor la sirve en producción
  cliente: process.env.CLIENTE_DIR ?? path.resolve(aqui, '..', '..', 'cliente', 'dist'),
  bd: path.resolve(aqui, '..', '..', 'bd'),
  horasSesion: 10,
  // El proxy (Caddy) termina TLS; detrás de él la cookie debe marcarse Secure
  cookieSegura: process.env.COOKIE_SEGURA !== '0',
  produccion: process.env.NODE_ENV === 'production',
};
