/**
 * Crea la base, las tablas y el primer administrador si no existen. Se ejecuta en cada arranque.
 * Modelo de datos del Anexo D de P2, con la estructura básica multiempresa y multialmacén de P1.
 */
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const config = require('./config');

const CS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

const TABLAS = [
  `CREATE TABLE IF NOT EXISTS empresa (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    prefijo_id CHAR(7) NOT NULL DEFAULT '0000000',
    responsable_datos VARCHAR(250) NULL
  ) ${CS}`,

  `CREATE TABLE IF NOT EXISTS almacen (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    nombre VARCHAR(150) NOT NULL,
    CONSTRAINT fk_almacen_empresa FOREIGN KEY (empresa_id) REFERENCES empresa(id)
  ) ${CS}`,

  // RF-21 y RNF-09: solo nombre, usuario y rol de cada persona
  `CREATE TABLE IF NOT EXISTS usuario (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    usuario VARCHAR(30) NOT NULL UNIQUE,
    nombre VARCHAR(120) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    rol ENUM('ALMACENISTA','SUPERVISOR','ADMINISTRACION') NOT NULL DEFAULT 'ALMACENISTA',
    activo TINYINT(1) NOT NULL DEFAULT 1,
    aviso_aceptado_en DATETIME NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_usuario_empresa FOREIGN KEY (empresa_id) REFERENCES empresa(id)
  ) ${CS}`,

  // Parámetros del umbral U(c) de la Sección VII.E; nulos = usar el valor por omisión
  `CREATE TABLE IF NOT EXISTS categoria (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    nombre VARCHAR(60) NOT NULL,
    conservacion ENUM('AMBIENTE','REFRIGERADO','CONGELADO') NOT NULL DEFAULT 'AMBIENTE',
    vu_dias SMALLINT NULL,
    vmr_dias SMALLINT NULL,
    tr_dias SMALLINT NULL,
    ms_dias SMALLINT NULL,
    UNIQUE KEY uq_categoria (empresa_id, nombre),
    CONSTRAINT fk_categoria_empresa FOREIGN KEY (empresa_id) REFERENCES empresa(id)
  ) ${CS}`,

  `CREATE TABLE IF NOT EXISTS producto (
    sku VARCHAR(14) PRIMARY KEY,
    empresa_id INT NOT NULL,
    nombre VARCHAR(120) NOT NULL,
    categoria_id INT NOT NULL,
    vida_util_dias SMALLINT NULL,
    requiere_frio TINYINT(1) NOT NULL DEFAULT 0,
    costo_caja DECIMAL(10,2) NOT NULL DEFAULT 0,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    INDEX ix_producto_nombre (nombre),
    CONSTRAINT fk_producto_empresa FOREIGN KEY (empresa_id) REFERENCES empresa(id),
    CONSTRAINT fk_producto_categoria FOREIGN KEY (categoria_id) REFERENCES categoria(id)
  ) ${CS}`,

  // RN-04: rack Z-Pnn-Rnn-Nn; piso Z-Fnn-Dn. «fila» agrupa las posiciones de una fila de piso.
  `CREATE TABLE IF NOT EXISTS posicion (
    id_posicion VARCHAR(16) PRIMARY KEY,
    almacen_id INT NOT NULL,
    zona VARCHAR(4) NOT NULL,
    tipo ENUM('RACK','PISO') NOT NULL,
    fila VARCHAR(16) NULL,
    profundidad TINYINT NOT NULL DEFAULT 1,
    es_frio TINYINT(1) NOT NULL DEFAULT 0,
    activa TINYINT(1) NOT NULL DEFAULT 1,
    INDEX ix_posicion_fila (fila, profundidad),
    CONSTRAINT fk_posicion_almacen FOREIGN KEY (almacen_id) REFERENCES almacen(id)
  ) ${CS}`,

  `CREATE TABLE IF NOT EXISTS lote (
    id_lote VARCHAR(36) PRIMARY KEY,
    sku VARCHAR(14) NOT NULL,
    num_lote VARCHAR(20) NOT NULL,
    fecha_caducidad DATE NOT NULL,
    caducidad_efectiva DATE NULL,
    motivo_caducidad_efectiva VARCHAR(200) NULL,
    fecha_recepcion DATE NOT NULL,
    autorizado_por INT NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_lote (sku, num_lote),
    INDEX ix_lote_caducidad (fecha_caducidad),
    INDEX ix_lote_num (num_lote),
    CONSTRAINT fk_lote_producto FOREIGN KEY (sku) REFERENCES producto(sku),
    CONSTRAINT fk_lote_autorizo FOREIGN KEY (autorizado_por) REFERENCES usuario(id)
  ) ${CS}`,

  // id_posicion único: una posición no puede tener dos tarimas; nulo = «por ubicar» (RF-06)
  `CREATE TABLE IF NOT EXISTS tarima (
    id_tarima VARCHAR(20) PRIMARY KEY,
    almacen_id INT NOT NULL,
    id_posicion VARCHAR(16) NULL UNIQUE,
    estado ENUM('ACTIVA','VACIA') NOT NULL DEFAULT 'ACTIVA',
    fecha_recepcion DATETIME NOT NULL,
    recibido_por INT NULL,
    CONSTRAINT fk_tarima_almacen FOREIGN KEY (almacen_id) REFERENCES almacen(id),
    CONSTRAINT fk_tarima_posicion FOREIGN KEY (id_posicion) REFERENCES posicion(id_posicion),
    CONSTRAINT fk_tarima_usuario FOREIGN KEY (recibido_por) REFERENCES usuario(id)
  ) ${CS}`,

  // RN-06: una tarima tiene uno o más lotes y un lote puede estar en varias tarimas. RNF-07: nunca negativo.
  `CREATE TABLE IF NOT EXISTS tarima_lote (
    id_tarima VARCHAR(20) NOT NULL,
    id_lote VARCHAR(36) NOT NULL,
    cajas INT NOT NULL,
    PRIMARY KEY (id_tarima, id_lote),
    INDEX ix_tl_lote (id_lote),
    CONSTRAINT ck_tl_cajas CHECK (cajas >= 0),
    CONSTRAINT fk_tl_tarima FOREIGN KEY (id_tarima) REFERENCES tarima(id_tarima),
    CONSTRAINT fk_tl_lote FOREIGN KEY (id_lote) REFERENCES lote(id_lote)
  ) ${CS}`,

  `CREATE TABLE IF NOT EXISTS serie (
    nombre VARCHAR(40) PRIMARY KEY,
    ultimo BIGINT NOT NULL
  ) ${CS}`,

  `CREATE TABLE IF NOT EXISTS pedido (
    id INT AUTO_INCREMENT PRIMARY KEY,
    almacen_id INT NOT NULL,
    folio VARCHAR(30) NOT NULL UNIQUE,
    cliente VARCHAR(150) NULL,
    estado ENUM('ABIERTO','CERRADO','CANCELADO') NOT NULL DEFAULT 'ABIERTO',
    creado_por INT NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cerrado_en DATETIME NULL,
    CONSTRAINT fk_pedido_almacen FOREIGN KEY (almacen_id) REFERENCES almacen(id),
    CONSTRAINT fk_pedido_usuario FOREIGN KEY (creado_por) REFERENCES usuario(id)
  ) ${CS}`,

  `CREATE TABLE IF NOT EXISTS linea_pedido (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pedido_id INT NOT NULL,
    renglon SMALLINT NOT NULL,
    sku VARCHAR(14) NOT NULL,
    cajas INT NOT NULL,
    cajas_surtidas INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_linea (pedido_id, renglon),
    CONSTRAINT ck_linea_cajas CHECK (cajas > 0 AND cajas_surtidas >= 0),
    CONSTRAINT fk_linea_pedido FOREIGN KEY (pedido_id) REFERENCES pedido(id),
    CONSTRAINT fk_linea_producto FOREIGN KEY (sku) REFERENCES producto(sku)
  ) ${CS}`,

  // Lista de surtido: cada renglón reserva cajas de un lote en una tarima (CF2)
  `CREATE TABLE IF NOT EXISTS reserva (
    id INT AUTO_INCREMENT PRIMARY KEY,
    linea_id INT NOT NULL,
    id_lote VARCHAR(36) NOT NULL,
    id_tarima VARCHAR(20) NOT NULL,
    cajas INT NOT NULL,
    estado ENUM('ABIERTA','SURTIDA','LIBERADA') NOT NULL DEFAULT 'ABIERTA',
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX ix_reserva_tl (id_tarima, id_lote, estado),
    CONSTRAINT fk_reserva_linea FOREIGN KEY (linea_id) REFERENCES linea_pedido(id),
    CONSTRAINT fk_reserva_lote FOREIGN KEY (id_lote) REFERENCES lote(id_lote),
    CONSTRAINT fk_reserva_tarima FOREIGN KEY (id_tarima) REFERENCES tarima(id_tarima)
  ) ${CS}`,

  // Historial de movimientos. Solo inserción (triggers abajo).
  `CREATE TABLE IF NOT EXISTS movimiento (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    almacen_id INT NOT NULL,
    tipo ENUM('ENTRADA','COLOCACION','REUBICACION','SALIDA','BAJA','AJUSTE') NOT NULL,
    id_tarima VARCHAR(20) NOT NULL,
    id_lote VARCHAR(36) NULL,
    cajas INT NOT NULL DEFAULT 0,
    pos_origen VARCHAR(16) NULL,
    pos_destino VARCHAR(16) NULL,
    linea_id INT NULL,
    lote_propuesto VARCHAR(36) NULL,
    conforme_fefo TINYINT(1) NULL,
    motivo_excepcion VARCHAR(30) NULL,
    justificacion VARCHAR(300) NULL,
    usuario_id INT NULL,
    tarea VARCHAR(30) NULL,
    origen_dato ENUM('SISTEMA','IMPORTADO') NOT NULL DEFAULT 'SISTEMA',
    fecha_hora DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX ix_mov_tarima (id_tarima, fecha_hora),
    INDEX ix_mov_lote (id_lote),
    INDEX ix_mov_tipo_fecha (tipo, fecha_hora),
    CONSTRAINT fk_mov_almacen FOREIGN KEY (almacen_id) REFERENCES almacen(id),
    CONSTRAINT fk_mov_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id)
  ) ${CS}`,

  // RF-16: propuesta de baja de un lote caducado. La autorización (RF-17) queda para la productización.
  `CREATE TABLE IF NOT EXISTS baja (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_lote VARCHAR(36) NOT NULL,
    id_tarima VARCHAR(20) NOT NULL,
    cajas INT NOT NULL,
    motivo ENUM('CADUCIDAD','DANO','OTRO') NOT NULL DEFAULT 'CADUCIDAD',
    estado ENUM('PENDIENTE','AUTORIZADA','RECHAZADA') NOT NULL DEFAULT 'PENDIENTE',
    registrada_por INT NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_baja_pendiente (id_lote, id_tarima, estado),
    CONSTRAINT fk_baja_lote FOREIGN KEY (id_lote) REFERENCES lote(id_lote),
    CONSTRAINT fk_baja_tarima FOREIGN KEY (id_tarima) REFERENCES tarima(id_tarima),
    CONSTRAINT fk_baja_usuario FOREIGN KEY (registrada_por) REFERENCES usuario(id)
  ) ${CS}`,

  // Bitácora de evaluación (subconjunto de RF-20): solo inserción para todos los usuarios
  `CREATE TABLE IF NOT EXISTS bitacora (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    fecha_hora DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    usuario_id INT NULL,
    tarea VARCHAR(30) NULL,
    modalidad VARCHAR(12) NOT NULL DEFAULT 'PROTOTIPO',
    accion VARCHAR(30) NOT NULL,
    entidad VARCHAR(30) NOT NULL,
    id_registro VARCHAR(40) NULL,
    escaneos SMALLINT NULL,
    resultado VARCHAR(30) NULL,
    valor_anterior JSON NULL,
    valor_nuevo JSON NULL,
    detalle VARCHAR(300) NULL,
    version VARCHAR(20) NULL,
    INDEX ix_bitacora_fecha (fecha_hora),
    INDEX ix_bitacora_tarea (tarea)
  ) ${CS}`,
];

// Nadie puede editar ni borrar la bitácora ni el historial de movimientos, ni siquiera desde SQL con la app
const TRIGGERS = ['bitacora', 'movimiento'].flatMap((t) => ['UPDATE', 'DELETE'].map((op) => `
  CREATE TRIGGER IF NOT EXISTS ${t}_sin_${op.toLowerCase()} BEFORE ${op} ON ${t} FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La tabla ${t} es de solo inserción'`));

async function preparar() {
  const { database, ...conexion } = config.db;
  const con = await mysql.createConnection({ ...conexion, multipleStatements: false });
  try {
    await con.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await con.changeUser({ database });
    for (const sql of TABLAS) await con.query(sql);
    for (const sql of TRIGGERS) await con.query(sql);

    await con.query(`INSERT IGNORE INTO empresa (id, nombre, prefijo_id) VALUES (1, 'Empresa piloto', '0750123')`);
    await con.query(`INSERT IGNORE INTO almacen (id, empresa_id, nombre) VALUES (1, 1, 'Almacén piloto')`);

    const [[{ admins }]] = await con.query(`SELECT COUNT(*) AS admins FROM usuario WHERE rol = 'ADMINISTRACION' AND activo = 1`);
    if (admins === 0) {
      const hash = await bcrypt.hash(config.admin.password, 10);
      await con.query(
        `INSERT INTO usuario (empresa_id, usuario, nombre, password_hash, rol) VALUES (1, ?, 'Administración', ?, 'ADMINISTRACION')
         ON DUPLICATE KEY UPDATE rol = 'ADMINISTRACION', activo = 1, password_hash = VALUES(password_hash)`,
        [config.admin.usuario, hash]);
      console.log(`Usuario inicial: ${config.admin.usuario} (cambia la contraseña en «Mi cuenta»)`);
    }
  } finally {
    await con.end();
  }
}

module.exports = { preparar };
