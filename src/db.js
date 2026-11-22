const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  dateStrings: true, // fechas como texto 'AAAA-MM-DD [hh:mm:ss]': sin corrimientos de zona horaria
  decimalNumbers: true,
});

/** Ejecuta una consulta y devuelve los renglones (o el resultado de un INSERT/UPDATE). */
async function q(sql, params = [], con = pool) {
  const [filas] = await con.query(sql, params);
  return filas;
}

/** Primer renglón o null. */
async function uno(sql, params = [], con = pool) {
  const filas = await q(sql, params, con);
  return filas[0] || null;
}

/** Ejecuta fn(conexion) dentro de una transacción. */
async function tx(fn) {
  const con = await pool.getConnection();
  try {
    await con.beginTransaction();
    const r = await fn(con);
    await con.commit();
    return r;
  } catch (e) {
    await con.rollback();
    throw e;
  } finally {
    con.release();
  }
}

/**
 * Como tx(), pero antes de abrir la transacción toma un candado con nombre (GET_LOCK). Así la transacción ve los
 * datos que dejó confirmados quien tenía el candado antes. Se usa al reservar cajas para el surtido (CF2).
 */
async function txConCandado(nombre, fn) {
  const con = await pool.getConnection();
  try {
    const [[{ ok }]] = await con.query('SELECT GET_LOCK(?, 10) AS ok', [nombre]);
    if (ok !== 1) throw new Error('El sistema está ocupado; intenta de nuevo en unos segundos.');
    try {
      await con.beginTransaction();
      const r = await fn(con);
      await con.commit();
      return r;
    } catch (e) {
      await con.rollback();
      throw e;
    } finally {
      await con.query('SELECT RELEASE_LOCK(?)', [nombre]);
    }
  } finally {
    con.release();
  }
}

/** Siguiente número de una serie, sin huecos ni duplicados aunque varios usuarios guarden a la vez. Dentro de tx(). */
async function siguiente(con, serie) {
  await con.query('INSERT INTO serie (nombre, ultimo) VALUES (?, 0) ON DUPLICATE KEY UPDATE ultimo = ultimo', [serie]);
  const [[s]] = await con.query('SELECT ultimo FROM serie WHERE nombre = ? FOR UPDATE', [serie]);
  const n = Number(s.ultimo) + 1;
  await con.query('UPDATE serie SET ultimo = ? WHERE nombre = ?', [n, serie]);
  return n;
}

module.exports = { pool, q, uno, tx, txConCandado, siguiente };
