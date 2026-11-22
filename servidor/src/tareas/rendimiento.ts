/**
 * PR-01 (RNF-01): búsqueda de ubicación p95 ≤ 2 s con 5 000 lotes, medida a través de la API completa
 * (validación, sesión, servicios, vistas de P3). Usa los datos de bd/05_rendimiento.sql en una base aparte.
 *
 *   npm run rendimiento -w servidor
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const BASE = 'fefo_rendimiento';
process.env.DATABASE_NAME = BASE;
process.env.DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://app_fefo:app-fefo-dev@localhost:5433/fefo').replace(/\/[^/]+$/, `/${BASE}`);
process.env.COOKIE_SEGURA = '0';

const { config } = await import('../config.js');
const { prepararBase, urlDe } = await import('./base.js');
await prepararBase(BASE, 'rendimiento2026');
const admin = new pg.Client({ connectionString: urlDe(BASE), options: '-c search_path=fefo -c timezone=America/Mexico_City' });
await admin.connect();
// Solo la carga de datos de 05_rendimiento.sql (las órdenes \timing y \echo son de psql)
const carga = readFileSync(path.join(config.bd, '05_rendimiento.sql'), 'utf8').split('\\timing')[0];
await admin.query(carga);
const n = (await admin.query<{ lotes: number; ubicadas: number }>(`SELECT (SELECT count(*) FROM lote)::int AS lotes, (SELECT count(*) FROM tarima WHERE estado = 'ubicada')::int AS ubicadas`)).rows[0];
await admin.end();

const { construir } = await import('../app.js');
const app = await construir();
const r = await app.inject({ method: 'POST', url: '/api/sesiones', payload: { usuario: 'sup01', contrasena: 'rendimiento2026' } });
const cookie = `fefo_sesion=${r.cookies[0].value}`;
await app.inject({ method: 'POST', url: '/api/aviso', headers: { cookie } });

async function medir(nombre: string, veces: number, peticion: (i: number) => { method: 'GET'; url: string }) {
  const t: number[] = [];
  for (let i = 0; i < veces; i++) {
    const ini = performance.now();
    const res = await app.inject({ ...peticion(i), headers: { cookie } });
    t.push(performance.now() - ini);
    if (res.statusCode >= 400) throw new Error(`${nombre}: ${res.statusCode} ${res.body}`);
  }
  t.sort((a, b) => a - b);
  const p = (q: number) => t[Math.min(t.length - 1, Math.ceil(q * t.length) - 1)].toFixed(1);
  return { prueba: nombre, peticiones: veces, mediana_ms: p(0.5), p95_ms: p(0.95), max_ms: t[t.length - 1].toFixed(1) };
}

const resultados = [
  await medir('GET /api/buscar (lote con bloqueo)', 100, (i) => ({ method: 'GET' as const, url: `/api/buscar?q=R${String(1 + ((i * 37) % 5000)).padStart(6, '0')}` })),
  await medir('GET /api/buscar (nombre de producto)', 50, (i) => ({ method: 'GET' as const, url: `/api/buscar?q=Producto%20${1 + i}` })),
  await medir('GET /api/alertas', 20, () => ({ method: 'GET' as const, url: '/api/alertas' })),
  await medir('GET /api/mapa', 20, () => ({ method: 'GET' as const, url: '/api/mapa' })),
];
await app.close();
const { pool } = await import('../bd.js');
await pool.end();
console.log(`PR-01 con ${n.lotes} lotes y ${n.ubicadas} tarimas ubicadas (criterio RNF-01: p95 ≤ 2000 ms)`);
console.table(resultados);
const peor = Math.max(...resultados.slice(0, 2).map((x) => Number(x.p95_ms)));
console.log(peor <= 2000 ? `✔ Cumple RNF-01: p95 de búsqueda ${peor} ms` : `✘ No cumple RNF-01: p95 ${peor} ms`);
