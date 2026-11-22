/** Conexión a PostgreSQL. Cada operación corre en una sola transacción (P3 V.D, «Consistencia»). */
import pg from 'pg';
import { config } from './config.js';

// DATE como texto 'AAAA-MM-DD': las caducidades se comparan como fechas locales, sin corrimientos de zona
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC y BIGINT como número (volúmenes pequeños)
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

// La base opera en America/Mexico_City (P3, Tabla XII); el esquema de P3 vive en «fefo»
export const OPCIONES_CONEXION = '-c search_path=fefo -c timezone=America/Mexico_City';
export const pool = new pg.Pool({ connectionString: config.urlBase, max: 10, options: OPCIONES_CONEXION });

export type Cliente = pg.PoolClient;

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = [], con: pg.Pool | pg.PoolClient = pool): Promise<T[]> {
  const r = await con.query(sql, params);
  return r.rows as T[];
}

export async function uno<T = Record<string, unknown>>(sql: string, params: unknown[] = [], con: pg.Pool | pg.PoolClient = pool): Promise<T | null> {
  const filas = await q<T>(sql, params, con);
  return filas[0] ?? null;
}

/**
 * Ejecuta fn dentro de una transacción. `usuario` se guarda en app.usuario para que la bitácora de la base
 * (tg_bitacora de P3) registre quién hizo cada cambio.
 */
export async function tx<T>(usuario: string | null, fn: (con: pg.PoolClient) => Promise<T>): Promise<T> {
  const con = await pool.connect();
  try {
    await con.query('BEGIN');
    if (usuario) await con.query(`SELECT set_config('app.usuario', $1, true)`, [usuario]);
    const r = await fn(con);
    await con.query('COMMIT');
    return r;
  } catch (e) {
    await con.query('ROLLBACK');
    throw e;
  } finally {
    con.release();
  }
}

/** Fecha local de la base (America/Mexico_City): la misma con que los disparadores evalúan RN-02. */
export async function hoy(con: pg.Pool | pg.PoolClient = pool): Promise<string> {
  const r = await uno<{ hoy: string }>(`SELECT current_date::text AS hoy`, [], con);
  return r!.hoy;
}
