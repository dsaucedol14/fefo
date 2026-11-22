/**
 * Prueba de integración de la API contra PostgreSQL 16 real (base fefo_prueba). Recorre los criterios de
 * aceptación de P2 y los escenarios de calidad de P3 en el núcleo del prototipo: PE-01, PE-02, PE-04, PE-05,
 * PE-07, PI-15/16 vía API, RNF-08, RF-21 y la evidencia de evaluación (OD7).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { prepararBase, urlDe } from '../tareas/base.js';

let app: FastifyInstance;
let admin: pg.Client;
const DISP = randomUUID();
const CLAVE = 'almacen2026';

type Sesion = { cookie: string };
async function entrar(usuario: string, contrasena = CLAVE): Promise<Sesion> {
  const r = await app.inject({ method: 'POST', url: '/api/sesiones', payload: { usuario, contrasena, id_dispositivo: DISP } });
  expect(r.statusCode, r.body).toBe(200);
  const cookie = r.cookies.find((c) => c.name === 'fefo_sesion')!;
  return { cookie: `fefo_sesion=${cookie.value}` };
}
const pedir = (s: Sesion, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, 'x-dispositivo': DISP } });
const ahora = () => new Date().toISOString();
const mov = (extra: Record<string, unknown>) => ({ id_mov: randomUUID(), fecha_dispositivo: ahora(), ...extra });

let alm: Sesion;
let sup: Sesion;
const LECHE = '7500000000011';
const ARROZ = '7500000000028';
const tarimas: Record<string, string> = {};

beforeAll(async () => {
  await prepararBase('fefo_prueba', CLAVE);
  admin = new pg.Client({ connectionString: urlDe('fefo_prueba'), options: '-c search_path=fefo' });
  await admin.connect();
  await admin.query(`INSERT INTO producto VALUES ($1, 'Leche entera 1 L caja 12', 1, TRUE, 22, 312.50), ($2, 'Arroz 1 kg caja 20', 3, FALSE, 240, 410.00)`, [LECHE, ARROZ]);
  const { construir } = await import('../app.js');
  app = await construir();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const { pool } = await import('../bd.js');
  await pool.end();
});

describe('sesión, aviso y roles (RNF-08, RNF-09, RF-21)', () => {
  it('exige aceptar el aviso de privacidad en el primer ingreso', async () => {
    alm = await entrar('alm01');
    expect((await pedir(alm, 'GET', '/api/productos')).json().codigo).toBe('aviso_pendiente');
    await pedir(alm, 'POST', '/api/aviso');
    expect((await pedir(alm, 'GET', '/api/productos')).statusCode).toBe(200);
    sup = await entrar('sup01');
    await pedir(sup, 'POST', '/api/aviso');
  });

  it('bloquea la cuenta al 5.º intento fallido y el supervisor la desbloquea', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await app.inject({ method: 'POST', url: '/api/sesiones', payload: { usuario: 'alm02', contrasena: 'mala' } })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/sesiones', payload: { usuario: 'alm02', contrasena: 'mala' } })).statusCode).toBe(423);
    expect((await app.inject({ method: 'POST', url: '/api/sesiones', payload: { usuario: 'alm02', contrasena: CLAVE } })).json().codigo).toBe('bloqueado');
    expect((await pedir(sup, 'PUT', '/api/usuarios/alm02', { desbloquear: true })).statusCode).toBe(200);
    await entrar('alm02');
  });

  it('el almacenista no ve alertas ni crea pedidos; la bitácora no guarda hashes', async () => {
    expect((await pedir(alm, 'GET', '/api/alertas')).statusCode).toBe(403);
    expect((await pedir(alm, 'POST', '/api/pedidos', { lineas: [{ sku: ARROZ, cajas: 1 }] })).statusCode).toBe(403);
    // Las altas de 02_catalogo.sql (antes de la extensión) solo llevan el marcador «bcrypt$pendiente»; ningún hash real
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM bitacora WHERE entidad = 'usuario'
      AND (valor_nuevo->>'hash_contrasena' LIKE '$2%' OR valor_anterior->>'hash_contrasena' LIKE '$2%')`);
    expect(rows[0].n).toBe(0);
  });
});

describe('recepción (PE-01: RF-01, RF-02, RF-04, RN-03, RN-05)', () => {
  const hoyMas = async (d: number) => (await admin.query(`SELECT (current_date + $1::int)::text AS f`, [d])).rows[0].f as string;

  it('recibe una tarima con dos lotes: ID de 18 dígitos con verificador, «por ubicar»', async () => {
    const r = await pedir(alm, 'POST', '/api/recepciones', { lotes: [
      { sku: ARROZ, num_lote: 'arz-01', fecha_caducidad: await hoyMas(200), cajas: 40 },
      { sku: ARROZ, num_lote: 'ARZ-02', fecha_caducidad: await hoyMas(220), cajas: 10 }], tarea: 'PRUEBA-01', escaneos: 2 });
    expect(r.statusCode, r.body).toBe(200);
    const t = r.json();
    expect(t.id_tarima).toMatch(/^00750123\d{10}$/);
    expect(t.estado).toBe('por_ubicar');
    expect(t.lotes.map((l: { num_lote: string }) => l.num_lote)).toEqual(['ARZ-01', 'ARZ-02']);
    tarimas.arroz1 = t.id_tarima;
    const pdf = await pedir(alm, 'GET', `/api/etiquetas/tarimas/${t.id_tarima}`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('rechaza un lote vencido y pide autorización si la vida remanente es poca', async () => {
    expect((await pedir(alm, 'POST', '/api/recepciones', { lotes: [{ sku: LECHE, num_lote: 'L-V', fecha_caducidad: await hoyMas(-1), cajas: 5 }] })).json().codigo).toBe('caducado');
    const poca = { lotes: [{ sku: LECHE, num_lote: 'LCH-01', fecha_caducidad: await hoyMas(3), cajas: 20 }] };
    const r = await pedir(alm, 'POST', '/api/recepciones', poca);
    expect(r.json().codigo).toBe('requiere_autorizacion');
    expect((await pedir(alm, 'POST', '/api/recepciones', { ...poca, autorizacion: { usuario: 'sup01', contrasena: 'mala' } })).json().codigo).toBe('autorizacion_invalida');
    const ok = await pedir(alm, 'POST', '/api/recepciones', { ...poca, autorizacion: { usuario: 'sup01', contrasena: CLAVE } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().autorizado_por).toBe('sup01');
    tarimas.leche = ok.json().id_tarima;
  });

  it('RN-05: no mezcla refrigerados y ambiente en una tarima', async () => {
    const r = await pedir(alm, 'POST', '/api/recepciones', { lotes: [
      { sku: ARROZ, num_lote: 'ARZ-09', fecha_caducidad: await hoyMas(200), cajas: 5 },
      { sku: LECHE, num_lote: 'LCH-09', fecha_caducidad: await hoyMas(20), cajas: 5 }] });
    expect(r.json().codigo).toBe('rn05_mezcla');
  });

  it('segunda tarima de arroz con caducidad más lejana', async () => {
    const r = await pedir(alm, 'POST', '/api/recepciones', { lotes: [{ sku: ARROZ, num_lote: 'ARZ-03', fecha_caducidad: await hoyMas(230), cajas: 30 }] });
    tarimas.arroz2 = r.json().id_tarima;
  });
});

describe('ubicación y reubicación (PE-02, PE-04: RF-05, RF-06, RF-08, RNF-03)', () => {
  it('sugiere solo cámara para refrigerados y nunca la cámara para ambiente', async () => {
    const s = (await pedir(alm, 'GET', `/api/posiciones/sugerencia?tarima=${tarimas.leche}`)).json();
    expect(s.posiciones.length).toBeGreaterThan(0);
    expect(s.posiciones.every((p: { zona: string }) => p.zona === 'C')).toBe(true);
    const a = (await pedir(alm, 'GET', `/api/posiciones/sugerencia?tarima=${tarimas.arroz1}`)).json();
    expect(a.posiciones.every((p: { zona: string }) => p.zona !== 'C')).toBe(true);
  });

  it('aplica, ignora el reenvío y rechaza ocupada, frío fuera de C y origen desactualizado', async () => {
    const u1 = mov({ tipo: 'ubicacion', id_tarima: tarimas.arroz1, pos_destino: 'B-F01-D2', tarea: 'PRUEBA-01', escaneos: 2 });
    const r = (await pedir(alm, 'POST', '/api/movimientos', { movimientos: [
      u1,
      u1, // reenvío del mismo id_mov (PI-16)
      mov({ tipo: 'ubicacion', id_tarima: tarimas.arroz2, pos_destino: 'B-F01-D2' }),
      mov({ tipo: 'ubicacion', id_tarima: tarimas.leche, pos_destino: 'A-P01-R01-N1' }),
      mov({ tipo: 'ubicacion', id_tarima: tarimas.arroz2, pos_destino: 'B-F01-D1' }),
      mov({ tipo: 'ubicacion', id_tarima: tarimas.leche, pos_destino: 'C-R01-N1' }),
      mov({ tipo: 'reubicacion', id_tarima: tarimas.arroz1, pos_origen: 'B-F09-D1', pos_destino: 'B-F02-D1' }),
    ] })).json().resultados;
    expect(r.map((x: { estado: string; codigo?: string }) => x.codigo ?? x.estado)).toEqual(
      ['aplicado', 'duplicado', 'posicion_ocupada', 'rn05_frio', 'aplicado', 'aplicado', 'origen_desactualizado']);
  });

  it('localiza el lote con su profundidad y la tarima que lo bloquea (PE-05, RF-07, RF-09)', async () => {
    const r = (await pedir(alm, 'GET', '/api/buscar?q=ARZ-01&tarea=PRUEBA-01&escaneos=1')).json();
    expect(r.resultados[0]).toMatchObject({ id_posicion: 'B-F01-D2', profundidad: 2, tarimas_delante: 1, bloqueada_por: tarimas.arroz2, es_candidato_fefo: true });
    expect((await pedir(alm, 'GET', '/api/buscar?q=B-F01-D1')).json()).toMatchObject({ tipo: 'tarima', id_tarima: tarimas.arroz2 });
  });
});

describe('surtido FEFO (PE-07: RF-11, RF-12, RF-13, C1, CF2)', () => {
  let pedido: string;
  it('propone el lote FEFO bloqueado con la alternativa accesible', async () => {
    const r = await pedir(sup, 'POST', '/api/pedidos', { cliente_ref: 'Escenario FEFO-01', lineas: [{ sku: ARROZ, cajas: 5 }] });
    expect(r.statusCode, r.body).toBe(200);
    const l = r.json();
    pedido = l.id_pedido;
    const res = l.renglones[0].reservas[0];
    expect(res).toMatchObject({ num_lote: 'ARZ-01', id_posicion: 'B-F01-D2', tarimas_delante: 1, cajas: 5 });
    expect(res.alternativa).toMatchObject({ id_tarima: tarimas.arroz2, id_posicion: 'B-F01-D1', dias_de_diferencia: 30 });
  });

  it('tomar la alternativa exige motivo; con motivo queda como excepción y la lista se reasigna', async () => {
    const l = (await pedir(alm, 'POST', '/api/listas-surtido', { id_pedido: pedido })).json();
    const res = l.renglones[0].reservas[0];
    const lote2 = (await admin.query(`SELECT id_lote FROM lote WHERE num_lote = 'ARZ-03'`)).rows[0].id_lote;
    const base = { tipo: 'salida', id_tarima: tarimas.arroz2, id_lote: lote2, cajas: 2, id_pedido: pedido, renglon: 1,
      id_reserva: res.id_reserva, id_lote_propuesto: res.id_lote, tarea: 'PRUEBA-01', escaneos: 1 };
    const sin = (await pedir(alm, 'POST', '/api/movimientos', { movimientos: [mov(base)] })).json().resultados[0];
    expect(sin.codigo).toBe('requiere_motivo');
    const con = (await pedir(alm, 'POST', '/api/movimientos', { movimientos: [mov({ ...base, motivo_excepcion: 'tarima_inaccesible' })] })).json().resultados[0];
    expect(con).toMatchObject({ estado: 'aplicado', es_fefo: false });
    const l2 = (await pedir(alm, 'POST', '/api/listas-surtido', { id_pedido: pedido })).json();
    expect(l2.renglones[0]).toMatchObject({ surtidas: 2 });
    expect(l2.renglones[0].reservas.reduce((s: number, x: { cajas: number }) => s + x.cajas, 0)).toBe(3);
  });

  it('la salida del lote propuesto es FEFO, descuenta el saldo y completa el pedido', async () => {
    const l = (await pedir(alm, 'POST', '/api/listas-surtido', { id_pedido: pedido })).json();
    const res = l.renglones[0].reservas[0];
    const r = (await pedir(alm, 'POST', '/api/movimientos', { movimientos: [mov({ tipo: 'salida', id_tarima: res.id_tarima, id_lote: res.id_lote, cajas: res.cajas,
      id_pedido: pedido, renglon: 1, id_reserva: res.id_reserva, id_lote_propuesto: res.id_lote, tarea: 'PRUEBA-01', escaneos: 1 })] })).json().resultados[0];
    expect(r).toMatchObject({ estado: 'aplicado', es_fefo: true });
    const saldo = (await admin.query(`SELECT cajas FROM tarima_lote WHERE id_tarima = $1 AND id_lote = $2`, [res.id_tarima, res.id_lote])).rows[0].cajas;
    expect(saldo).toBe(37);
    expect((await pedir(alm, 'POST', '/api/listas-surtido', { id_pedido: pedido })).json().estado).toBe('surtido');
    // No se puede surtir de más
    const extra = (await pedir(alm, 'POST', '/api/movimientos', { movimientos: [mov({ tipo: 'salida', id_tarima: res.id_tarima, id_lote: res.id_lote, cajas: 1, id_pedido: pedido, renglon: 1 })] })).json().resultados[0];
    expect(extra.codigo).toBe('renglon_completo');
  });

  it('un lote caducado no sale (RN-02) y se propone su baja (RF-16)', async () => {
    await admin.query(`SET app.usuario = 'sup01'`);
    const { rows } = await admin.query(`INSERT INTO lote (sku, num_lote, fecha_caducidad, fecha_recepcion) VALUES ($1, 'LCH-00', current_date - 1, current_date - 20) RETURNING id_lote`, [LECHE]);
    await admin.query(`INSERT INTO tarima (id_tarima) VALUES ('000000000000000099')`);
    await admin.query(`INSERT INTO movimiento (id_mov, tipo, id_tarima, id_lote, delta_cajas, id_usuario, fecha_dispositivo) VALUES (gen_random_uuid(), 'recepcion', '000000000000000099', $1, 5, 'sup01', now() - interval '20 days')`, [rows[0].id_lote]);
    await admin.query(`INSERT INTO movimiento (id_mov, tipo, id_tarima, pos_destino, id_usuario, fecha_dispositivo) VALUES (gen_random_uuid(), 'ubicacion', '000000000000000099', 'C-R02-N1', 'sup01', now())`);
    const r = (await pedir(alm, 'POST', '/api/movimientos', { movimientos: [mov({ tipo: 'salida', id_tarima: '000000000000000099', id_lote: rows[0].id_lote, cajas: 1, motivo_excepcion: 'producto_danado' })] })).json().resultados[0];
    expect(r.codigo).toBe('caducado');
    const b = (await pedir(alm, 'POST', '/api/bajas', { id_lote: rows[0].id_lote, id_tarima: '000000000000000099', motivo: 'caducidad' })).json();
    expect(b).toMatchObject({ estado: 'pendiente', cajas: 5 });
    const a = (await pedir(sup, 'GET', '/api/alertas')).json();
    expect(a.conteo.vencido).toBeGreaterThanOrEqual(1);
    expect(a.bajas).toHaveLength(1);
  });
});

describe('evidencia y estado (OD7, RNF-07, RF-20)', () => {
  it('las vistas de conservación y bitácora quedan vacías y los movimientos llevan tarea, dispositivo y propuesta', async () => {
    const { rows } = await admin.query(`SELECT (SELECT count(*) FROM v_conservacion)::int AS i8, (SELECT count(*) FROM v_posicion_vs_bitacora)::int AS i9`);
    expect(rows[0]).toEqual({ i8: 0, i9: 0 });
    const csv = (await pedir(sup, 'GET', '/api/exportes/movimientos.csv')).body;
    expect(csv).toContain('PRUEBA-01');
    expect(csv).toContain(DISP);
    expect(csv).toContain('tarima_inaccesible');
    const t = (await pedir(sup, 'GET', '/api/evaluacion/tareas')).json();
    expect(t.find((x: { tarea: string }) => x.tarea === 'PRUEBA-01')).toMatchObject({ salidas: 2, salidas_fefo: 1 });
    await expect(admin.query(`UPDATE movimiento SET escaneos = 0`)).rejects.toThrow(/solo inserción/);
  });
});
