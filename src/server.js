const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

const config = require('./config');
const { pool } = require('./db');
const { preparar } = require('./esquema');
const util = require('./util');
const seg = require('./seguridad');
const { MOTIVOS } = require('./dominio/reglas');

async function certificado() {
  const llave = path.join(config.certificados, 'llave.pem');
  const cert = path.join(config.certificados, 'cert.pem');
  if (!fs.existsSync(llave) || !fs.existsSync(cert)) {
    const selfsigned = require('selfsigned');
    const os = require('os');
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4').map((i) => i.address);
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'fefo-tarimas' }], {
      days: 825, keySize: 2048,
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))] }],
    });
    fs.mkdirSync(config.certificados, { recursive: true });
    fs.writeFileSync(llave, pems.private);
    fs.writeFileSync(cert, pems.cert);
    console.log(`Certificado autofirmado creado en ${config.certificados}`);
  }
  return { key: fs.readFileSync(llave), cert: fs.readFileSync(cert) };
}

async function iniciar() {
  await preparar();

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use(seg.encabezados);
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  // Bibliotecas locales: el almacén puede no tener internet (RNF-03 queda para productización, pero no dependemos de un CDN)
  app.get('/static/vendor/html5-qrcode.min.js', (req, res) =>
    res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js')));
  app.get('/static/js/gs1.js', (req, res) => res.sendFile(path.join(__dirname, 'dominio', 'gs1.js')));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use(session({
    name: 'fefo.sid',
    secret: config.secretoSesion,
    store: new MySQLStore({ createDatabaseTable: true, clearExpired: true }, pool),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 10 * 60 * 60 * 1000 },
  }));
  // Toda redirección espera a que la sesión quede guardada en MySQL (si no, el navegador leería la sesión vieja)
  app.use((req, res, next) => {
    const redirigir = res.redirect.bind(res);
    res.redirect = (...args) => (req.session
      ? req.session.save((err) => (err ? next(err) : redirigir(...args)))
      : redirigir(...args));
    next();
  });
  app.use(seg.flash);
  app.use(seg.csrf);
  app.use(seg.cargarUsuario);
  app.use((req, res, next) => {
    res.locals.f = util;
    res.locals.ruta = req.path;
    res.locals.titulo = 'FEFO Tarimas';
    res.locals.hoy = util.hoy();
    res.locals.fechaSimulada = !!config.fechaOperacion;
    res.locals.version = config.version;
    res.locals.MOTIVOS = MOTIVOS;
    next();
  });
  app.use(seg.validarCsrf);

  app.use(require('./rutas/acceso'));
  app.use(seg.requiereSesion);
  app.use(seg.requiereAviso);
  app.use(require('./rutas/inicio'));
  app.use(require('./rutas/recepcion'));
  app.use(require('./rutas/tarimas'));
  app.use(require('./rutas/localizar'));
  app.use(require('./rutas/pedidos'));
  app.use(require('./rutas/alertas'));
  app.use(require('./rutas/posiciones'));
  app.use('/admin', seg.requiereSupervisor, require('./rutas/admin'));

  app.use((req, res) => res.status(404).render('error', { titulo: 'No encontrado', mensaje: 'La página que buscas no existe.' }));
  app.use((err, req, res, next) => {
    console.error(err);
    // Si la respuesta ya empezó a enviarse, Express la cierra; volver a responder tiraría el proceso
    if (res.headersSent) return next(err);
    res.status(500).render('error', { titulo: 'Error', mensaje: err.publico || 'Ocurrió un error inesperado. Si se repite, avisa al supervisor.' });
  });

  http.createServer(app).listen(config.puerto, () => console.log(`FEFO Tarimas en http://localhost:${config.puerto}`));
  if (config.puertoHttps) {
    https.createServer(await certificado(), app).listen(config.puertoHttps, () =>
      console.log(`HTTPS (para la cámara de los teléfonos) en https://IP-de-este-equipo:${config.puertoHttps}`));
  }
  if (config.fechaOperacion) console.log(`Fecha de operación fija: ${config.fechaOperacion} (FECHA_OPERACION en .env)`);
}

iniciar().catch((e) => {
  console.error('No se pudo arrancar:', e.message);
  if (e.code === 'ECONNREFUSED') console.error('¿Está encendido MySQL en Laragon?');
  process.exit(1);
});
