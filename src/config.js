const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const raiz = path.join(__dirname, '..');
const paquete = require('../package.json');

module.exports = {
  raiz,
  version: paquete.version,
  puerto: Number(process.env.PORT || 3200),
  // Si se define, también se sirve por HTTPS (la cámara del teléfono solo funciona con HTTPS o en localhost)
  puertoHttps: process.env.HTTPS_PORT ? Number(process.env.HTTPS_PORT) : null,
  certificados: path.resolve(raiz, process.env.CERTS_DIR || './certs'),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'fefo_tarimas',
  },
  secretoSesion: process.env.SESSION_SECRET || 'solo-para-desarrollo-cambiar',
  admin: {
    usuario: process.env.ADMIN_USUARIO || 'admin',
    password: process.env.ADMIN_PASSWORD || 'fefo-dev-2026',
  },
  // Fecha de operación fija (AAAA-MM-DD) para trabajar con los datos sintéticos del Anexo C.
  // Vacía = fecha real del equipo. Afecta caducidades, alertas y rotación; no la hora de los movimientos.
  fechaOperacion: process.env.FECHA_OPERACION || '',
  // Umbral de alerta por omisión cuando una categoría no tiene parámetros (RN-07)
  umbralOmision: Number(process.env.UMBRAL_OMISION_DIAS || 30),
  // Ventana para la demanda media diaria del criterio por rotación (Sección VII.E)
  diasDemanda: 14,
  produccion: process.env.NODE_ENV === 'production',
};
