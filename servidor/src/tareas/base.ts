/** Creación de la base con el modelo de P3 y la extensión del prototipo; la usan la tarea de consola y las pruebas. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

export function urlDe(nombre: string): string {
  const url = new URL(config.urlAdmin);
  url.pathname = `/${nombre}`;
  return url.toString();
}

export async function prepararBase(nombre: string, claveUsuarios?: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(nombre)) throw new Error('Nombre de base inválido.');
  const admin = new pg.Client({ connectionString: config.urlAdmin });
  await admin.connect();
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [nombre]);
  await admin.query(`DROP DATABASE IF EXISTS ${nombre}`);
  await admin.query(`CREATE DATABASE ${nombre}`);
  await admin.query(`ALTER DATABASE ${nombre} SET timezone = 'America/Mexico_City'`);
  await admin.end();

  const con = new pg.Client({ connectionString: urlDe(nombre), options: '-c timezone=America/Mexico_City' });
  await con.connect();
  try {
    for (const archivo of ['01_esquema.sql', '02_catalogo.sql', '06_extension_prototipo.sql']) {
      await con.query(readFileSync(path.join(config.bd, archivo), 'utf8'));
    }
    await con.query(`ALTER ROLE app_fefo WITH LOGIN PASSWORD '${config.claveApp.replace(/'/g, "''")}'`);
    await con.query(`ALTER ROLE app_fefo SET search_path = fefo`);
    await con.query(`GRANT CONNECT ON DATABASE ${nombre} TO app_fefo`);
    if (claveUsuarios) {
      if (claveUsuarios.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres (RNF-08).');
      await con.query(`UPDATE fefo.usuario SET hash_contrasena = $1 WHERE hash_contrasena = 'bcrypt$pendiente'`, [await bcrypt.hash(claveUsuarios, 10)]);
    }
  } finally {
    await con.end();
  }
}
