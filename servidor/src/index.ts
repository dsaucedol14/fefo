import { construir } from './app.js';
import { config } from './config.js';
import { pool } from './bd.js';

const app = await construir();
try {
  await pool.query('SELECT 1');
} catch (e) {
  console.error(`No se pudo conectar a PostgreSQL (${(e as Error).message}). ¿Está encendido el contenedor «bd»?`);
  process.exit(1);
}
await app.listen({ port: config.puerto, host: config.anfitrion });
console.log(`API FEFO v${config.version} en http://${config.anfitrion}:${config.puerto}`);

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
