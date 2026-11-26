/**
 * Carga el caso simulado [S] de sim.py (P2 v2) en la base, igual que bd/04_reproducir_sim.py de P3:
 * cada recepción, ubicación, reubicación, salida y baja se inserta como MOVIMIENTO y los disparadores la aplican
 * (ADR-006). Al final compara saldos, es_fefo y las vistas I8 e I9 (PI-28), y verifica que el motor FEFO y la base
 * coincidan en cada salida (PU-05).
 *
 * Con --desplazar (por omisión) recorre todas las fechas para que el último día simulado sea ayer; así las
 * caducidades y alertas tienen sentido respecto a la fecha real. --sin-desplazar conserva las fechas originales.
 *
 *   python sim.py --salida datos/sim_v2
 *   npm run bd:cargar-sim -- ../datos/sim_v2
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { config } from '../config.js';
import { esFefo, diasEntre } from '../dominio/fefo/motor.js';

const carpeta = process.argv[2];
const desplazar = !process.argv.includes('--sin-desplazar');
const CATS: Record<string, number> = { Lácteos: 1, Embutidos: 2, Abarrotes: 3, Bebidas: 4, Botanas: 5 };
const NOMBRES: Record<string, string[]> = {
  Lácteos: ['Leche entera 1 L', 'Leche deslactosada 1 L', 'Yogur natural 1 kg', 'Queso panela 400 g', 'Crema ácida 450 ml', 'Queso Oaxaca 1 kg', 'Yogur bebible 250 g', 'Mantequilla 90 g'],
  Embutidos: ['Jamón de pavo 1 kg', 'Salchicha viena 500 g', 'Chorizo 1 kg', 'Tocino 250 g', 'Mortadela 1 kg', 'Salami 200 g', 'Pechuga de pavo 1 kg', 'Longaniza 1 kg'],
  Abarrotes: ['Arroz 1 kg', 'Frijol negro 1 kg', 'Aceite vegetal 1 L', 'Atún en agua 140 g', 'Azúcar 1 kg', 'Harina de trigo 1 kg', 'Pasta para sopa 200 g', 'Café soluble 120 g', 'Avena 400 g', 'Sal 1 kg'],
  Bebidas: ['Refresco cola 600 ml', 'Agua natural 1 L', 'Jugo de naranja 1 L', 'Bebida isotónica 1 L', 'Té helado 500 ml', 'Agua mineral 600 ml', 'Néctar de mango 1 L', 'Refresco limón 2 L'],
  Botanas: ['Papas fritas 45 g', 'Galletas surtidas 600 g', 'Cacahuates 100 g', 'Totopos 200 g', 'Palomitas 80 g', 'Galletas saladas 300 g', 'Barras de cereal 6 pz', 'Churritos 60 g'],
};

function leer(nombre: string): Record<string, string>[] {
  const texto = readFileSync(path.join(carpeta, nombre), 'utf8').replace(/^﻿/, '');
  const [cab, ...filas] = texto.trim().split(/\r?\n/);
  const campos = cab.split(',');
  return filas.map((f) => Object.fromEntries(f.split(',').map((v, i) => [campos[i], v])));
}

// Mismos identificadores que 04_reproducir_sim.py: T0524 → 000000000000000524; el lote, UUID derivado del código
const tid = (t: string) => String(Number(t.slice(1))).padStart(18, '0');
function lid(l: string): string {
  const h = createHash('sha1').update(`fefo-sim:${l}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function main() {
  if (!carpeta) {
    console.log('Uso: npm run bd:cargar-sim -- <carpeta con los CSV de sim.py> [--sin-desplazar]');
    process.exit(1);
  }
  const url = new URL(config.urlAdmin);
  url.pathname = `/${config.nombreBase}`;
  const con = new pg.Client({ connectionString: url.toString(), options: '-c search_path=fefo -c timezone=America/Mexico_City' });
  await con.connect();
  pg.types.setTypeParser(1082, (v) => v);
  await con.query(`SET app.usuario = 'alm01'`);

  const [{ n }] = (await con.query(`SELECT count(*)::int AS n FROM movimiento`)).rows;
  if (n > 0) throw new Error('La base ya tiene movimientos. Ejecuta primero: npm run bd:preparar -- --reiniciar');

  const prods = leer('productos.csv');
  const lotes = leer('lotes.csv');
  const movs = leer('movimientos.csv');
  const sels = leer('selecciones.csv');
  const mermas = leer('mermas.csv');
  const ultimo = movs.reduce((m, x) => (x.fecha > m ? x.fecha : m), '0000-00-00');
  const hoyReal: string = (await con.query(`SELECT current_date::text AS d`)).rows[0].d;
  const desfase = desplazar ? diasEntre(ultimo, hoyReal) - 1 : 0;
  const mover = (f: string) => {
    if (!desfase) return f;
    const [a, m, d] = f.split('-').map(Number);
    const x = new Date(Date.UTC(a, m - 1, d + desfase));
    return x.toISOString().slice(0, 10);
  };

  await con.query('BEGIN');
  const usados: Record<string, number> = {};
  for (const p of prods) {
    const lista = NOMBRES[p.categoria];
    const i = usados[p.categoria] = (usados[p.categoria] ?? -1) + 1;
    const nombre = `${lista[i % lista.length]} · caja ${p.cajas_tarima}`;
    await con.query(`INSERT INTO producto (sku, nombre, id_categoria, requiere_frio, vida_util_dias, costo_caja) VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.sku, nombre, CATS[p.categoria], p.frio === 'True', Number(p.vida_util_dias), Number(p.costo_caja)]);
  }
  const porTarima = new Map<string, Record<string, string>[]>();
  const final = new Map<string, number>();
  for (const l of lotes) {
    await con.query(`INSERT INTO lote (id_lote, sku, num_lote, fecha_caducidad, fecha_recepcion) VALUES ($1, $2, $3, $4, $5)`,
      [lid(l.lote), l.sku, l.lote, mover(l.fecha_caducidad), mover(l.fecha_recepcion)]);
    final.set(lid(l.lote), Number(l.cajas_finales));
    if (!porTarima.has(l.tarima)) porTarima.set(l.tarima, []);
    porTarima.get(l.tarima)!.push(l);
  }
  for (const t of [...porTarima.keys()].sort()) await con.query(`INSERT INTO tarima (id_tarima) VALUES ($1)`, [tid(t)]);
  await con.query('COMMIT');

  const seg = new Map<string, number>();
  const ts = (fecha: string) => {
    const s = (seg.get(fecha) ?? 0) + 1;
    seg.set(fecha, s);
    return `${fecha} ${String(6 + Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}-06`;
  };
  let aceptados = 0;
  const rechazos: Record<string, number> = {};
  let salidas = 0;
  let coincideSim = 0;
  let coincideMotor = 0;
  let conformes = 0;
  const sku = new Map(lotes.map((l) => [lid(l.lote), l.sku]));

  async function mov(tipo: string, t: string, fecha: string, o: { lote?: string; delta?: number; ori?: string | null; des?: string | null; motivo?: string | null } = {}) {
    try {
      const r = await con.query(
        `INSERT INTO movimiento (id_mov, tipo, id_tarima, id_lote, delta_cajas, pos_origen, pos_destino, motivo_excepcion, id_usuario, fecha_dispositivo)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'alm01', $8) RETURNING es_fefo`,
        [tipo, tid(t), o.lote ?? null, o.delta ?? 0, o.ori ?? null, o.des ?? null, o.motivo ?? null, ts(fecha)]);
      aceptados++;
      return r.rows[0] as { es_fefo: boolean | null };
    } catch (e) {
      const clave = String((e as Error).message).replace(/ [0-9]{18}.*| L[0-9]{5}.*/, '').slice(0, 60);
      rechazos[clave] = (rechazos[clave] ?? 0) + 1;
      return null;
    }
  }

  let iSel = 0;
  let iMerma = 0;
  const inicio = Date.now();
  for (const m of movs) {
    const f = mover(m.fecha);
    if (m.tipo === 'ENTRADA') {
      for (const l of porTarima.get(m.tarima)!) await mov('recepcion', m.tarima, f, { lote: lid(l.lote), delta: Number(l.cajas_recibidas) });
      await mov('ubicacion', m.tarima, f, { des: m.destino });
    } else if (m.tipo === 'REUBICACION') {
      await mov('reubicacion', m.tarima, f, { ori: m.origen, des: m.destino });
    } else if (m.tipo === 'SALIDA') {
      const s = sels[iSel++];
      const conforme = s.conforme_fefo === '1';
      const idl = lid(s.lote_elegido);
      // PU-05: lo que el motor diría con las existencias justo antes de la salida
      const ex = (await con.query(
        `SELECT COALESCE(l.caducidad_efectiva, l.fecha_caducidad)::text AS caducidad_vigente, sum(tl.cajas)::int AS cajas
           FROM lote l JOIN tarima_lote tl USING (id_lote) WHERE l.sku = $1 AND l.estado = 'disponible' GROUP BY 1`, [sku.get(idl)])).rows;
      const cadElegido = (await con.query(`SELECT COALESCE(caducidad_efectiva, fecha_caducidad)::text AS c FROM lote WHERE id_lote = $1`, [idl])).rows[0].c;
      const motor = esFefo(cadElegido, ex, f);
      const r = await mov('salida', m.tarima, f, { lote: idl, delta: -Number(m.cajas), motivo: conforme ? null : 'decision_operador' });
      salidas++;
      if (r) {
        if (r.es_fefo === conforme) coincideSim++;
        if (r.es_fefo === motor) coincideMotor++;
        if (r.es_fefo) conformes++;
      }
    } else if (m.tipo === 'BAJA_CADUCIDAD') {
      const mm = mermas[iMerma++];
      await mov('baja', m.tarima, f, { lote: lid(mm.lote), delta: -Number(m.cajas) });
    }
  }
  const seriesUsadas = [...porTarima.keys()].length;
  await con.query(`SELECT setval('seq_tarima', $1)`, [seriesUsadas + 1]);

  const res = (await con.query(`
    SELECT (SELECT count(*) FROM v_conservacion)::int AS i8, (SELECT count(*) FROM v_posicion_vs_bitacora)::int AS i9,
           (SELECT count(*) FROM tarima t JOIN tarima_lote tl USING (id_tarima) JOIN lote l USING (id_lote) JOIN producto p USING (sku)
             JOIN posicion po ON po.id_posicion = t.id_posicion JOIN zona z USING (id_zona) WHERE p.requiere_frio AND NOT z.es_fria)::int AS frio_fuera`)).rows[0];
  const saldos = (await con.query(`SELECT id_lote, sum(cajas)::int AS c FROM tarima_lote GROUP BY id_lote`)).rows as { id_lote: string; c: number }[];
  const saldo = new Map(saldos.map((s) => [s.id_lote, s.c]));
  const distintos = [...final].filter(([id, c]) => (saldo.get(id) ?? 0) !== c).length;
  await con.end();

  console.log(`Caso simulado [S] cargado en ${((Date.now() - inicio) / 1000).toFixed(1)} s${desfase ? ` (fechas recorridas ${desfase} días; último día simulado = ayer)` : ''}`);
  console.table({
    movimientos_aceptados: aceptados, salidas_simuladas: salidas, es_fefo_coincide_con_sim: coincideSim,
    'PU-05 motor = base': `${coincideMotor} de ${salidas}`, conformidad_fefo_pct: Number((100 * conformes / Math.max(1, salidas)).toFixed(1)),
    lotes_con_saldo_distinto: distintos, incidencias_I8: res.i8, incidencias_I9: res.i9, refrigerados_fuera_de_C: res.frio_fuera,
  });
  if (Object.keys(rechazos).length) console.log('Rechazados por la base:', rechazos);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
