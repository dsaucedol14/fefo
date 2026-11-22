/** Consultas de inventario sobre las vistas de P3 (v_existencia, v_bloqueo, v_alerta). SQL parametrizado. */
import type { Pool, PoolClient } from 'pg';
import { pool, q } from '../bd.js';
import type { Candidato } from '../dominio/fefo/motor.js';

type Con = Pool | PoolClient;

/**
 * Inventario vigente de un producto para el motor: saldo libre (descontadas las reservas abiertas, CF2) y
 * accesibilidad (tarimas delante en la fila, RF-07). Solo lotes disponibles.
 */
export async function candidatos(sku: string, con: Con = pool): Promise<Candidato[]> {
  const filas = await q<Candidato & { bloqueada_por: string | null }>(
    `SELECT e.id_lote, e.num_lote, e.id_tarima, e.id_posicion, e.caducidad_vigente, e.fecha_recepcion::text AS fecha_recepcion,
            (e.cajas - COALESCE(r.reservado, 0))::int AS saldo,
            COALESCE(b.tarimas_delante, 0)::int AS tarimas_delante, b.bloqueada_por
       FROM v_existencia e
       JOIN lote l USING (id_lote)
       LEFT JOIN v_bloqueo b USING (id_tarima)
       LEFT JOIN (SELECT id_tarima, id_lote, sum(cajas) AS reservado FROM reserva WHERE estado = 'abierta' GROUP BY 1, 2) r
              USING (id_tarima, id_lote)
      WHERE e.sku = $1 AND l.estado = 'disponible'`, [sku], con);
  return filas.map((f) => ({ ...f, bloqueada_por: f.bloqueada_por ? f.bloqueada_por.split(',') : [] }));
}

/** Demanda media diaria (cajas) de un producto en la ventana del parámetro ventana_demanda_dias (14). */
export async function demandaMedia(sku: string, con: Con = pool): Promise<number> {
  const [r] = await q<{ d: number }>(
    `SELECT COALESCE(-sum(m.delta_cajas), 0)::numeric / v.dias AS d
       FROM (SELECT COALESCE((SELECT valor FROM parametro WHERE clave = 'ventana_demanda_dias'), 14) AS dias) v
       LEFT JOIN lote l ON l.sku = $1
       LEFT JOIN movimiento m ON m.id_lote = l.id_lote AND m.tipo = 'salida'
                             AND m.fecha_dispositivo >= now() - make_interval(days => v.dias::int)
      GROUP BY v.dias`, [sku], con);
  return Number(r?.d ?? 0);
}

/** Bloqueo de una lista de tarimas: tarimas delante y cuáles son (v_bloqueo). */
export async function bloqueos(tarimas: string[], con: Con = pool): Promise<Map<string, { tarimas_delante: number; bloqueada_por: string[] }>> {
  if (!tarimas.length) return new Map();
  const filas = await q<{ id_tarima: string; tarimas_delante: number; bloqueada_por: string | null }>(
    `SELECT id_tarima, tarimas_delante::int, bloqueada_por FROM v_bloqueo WHERE id_tarima = ANY($1)`, [tarimas], con);
  return new Map(filas.map((f) => [f.id_tarima, { tarimas_delante: f.tarimas_delante, bloqueada_por: f.bloqueada_por ? f.bloqueada_por.split(',') : [] }]));
}
