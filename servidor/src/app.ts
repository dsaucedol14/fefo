/** Construye la aplicación Fastify: API REST, cliente PWA compilado y manejo de errores. */
import { existsSync } from 'node:fs';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import estatico from '@fastify/static';
import { config } from './config.js';
import { ErrorNegocio, traducir } from './errores.js';
import { rutas } from './api/rutas.js';

export async function construir() {
  const app = Fastify({
    logger: config.produccion ? { level: 'info' } : false,
    trustProxy: true,
    bodyLimit: 512 * 1024,
  });
  await app.register(cookie);

  // Encabezados de seguridad y protección CSRF: toda escritura debe venir del mismo origen (además de SameSite=Strict)
  app.addHook('onRequest', async (req, rep) => {
    rep.header('X-Content-Type-Options', 'nosniff');
    rep.header('Referrer-Policy', 'same-origin');
    rep.header('X-Frame-Options', 'DENY');
    rep.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.url.startsWith('/api/')) {
      const origen = req.headers.origin;
      if (origen && new URL(origen).host !== req.headers.host) {
        return rep.code(403).send({ codigo: 'origen', mensaje: 'Origen no permitido.' });
      }
    }
  });

  app.setErrorHandler((error: FastifyError, req, rep) => {
    if (error.validation) {
      return rep.code(400).send({ codigo: 'datos_invalidos', mensaje: 'Los datos enviados no son válidos.', detalle: error.message });
    }
    const negocio = error instanceof ErrorNegocio ? error : traducir(error);
    if (negocio) return rep.code(negocio.estado).send({ codigo: negocio.codigo, mensaje: negocio.message, ...negocio.extra });
    req.log.error(error);
    if (!config.produccion) console.error(error);
    return rep.code(500).send({ codigo: 'interno', mensaje: 'Ocurrió un error inesperado. Si se repite, avisa al supervisor.' });
  });

  await app.register(rutas);
  app.get('/api/*', async (req, rep) => rep.code(404).send({ codigo: 'no_encontrado', mensaje: 'Ruta no encontrada.' }));

  // Cliente PWA compilado; cualquier ruta que no sea de la API devuelve la aplicación (navegación del lado del cliente)
  if (existsSync(config.cliente)) {
    // wildcard (por omisión): sirve los archivos que existan al pedirlos, aunque el cliente se recompile en marcha
    await app.register(estatico, { root: config.cliente, index: ['index.html'],
      setHeaders: (res, ruta) => { if (/sw\.js$|index\.html$|manifest\.webmanifest$/.test(ruta)) res.header('Cache-Control', 'no-cache'); } });
    app.setNotFoundHandler((req, rep) => (req.url.startsWith('/api/') ? rep.code(404).send({ codigo: 'no_encontrado' }) : rep.sendFile('index.html')));
  }
  return app;
}
