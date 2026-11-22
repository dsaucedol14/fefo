/**
 * Evidencia para P4 (OD7, P2 III.F): eventos de evaluación (inicio y fin de tarea, búsquedas) y exportes CSV de
 * movimientos, eventos y bitácora. Los usuarios se exportan por su código (alm01), nunca por nombre.
 */
import { q } from '../../bd.js';
import type { Usuario } from '../../seguridad/sesion.js';

export async function registrarEvento(e: { tipo: string; tarea?: string | null; escaneos?: number | null; resultado?: string | null;
  detalle?: unknown; fecha_dispositivo?: string | null }, usuario: Usuario, idDispositivo: string | null) {
  await q(`INSERT INTO evento (tipo, id_usuario, id_dispositivo, tarea, escaneos, resultado, detalle, fecha_dispositivo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.tipo, usuario.id_usuario, idDispositivo, e.tarea ?? null, e.escaneos ?? null, e.resultado ?? null,
      e.detalle === undefined ? null : JSON.stringify(e.detalle), e.fecha_dispositivo ?? null]);
}

/** Rechazos de sincronizaciones diferidas, para revisión del supervisor (ADR-004). */
export const rechazos = () => q(
  `SELECT id, id_usuario, id_dispositivo, resultado AS codigo, detalle->>'mensaje' AS mensaje, detalle->'movimiento' AS movimiento,
          fecha_dispositivo::text, fecha_servidor::text
     FROM evento WHERE tipo = 'rechazo_sync' ORDER BY id DESC LIMIT 200`);

export const tareas = () => q(
  `SELECT tarea, count(*)::int AS movimientos, min(fecha_dispositivo)::text AS inicio, max(fecha_dispositivo)::text AS fin,
          count(*) FILTER (WHERE tipo = 'salida')::int AS salidas, count(*) FILTER (WHERE tipo = 'salida' AND es_fefo)::int AS salidas_fefo
     FROM movimiento WHERE tarea IS NOT NULL GROUP BY tarea ORDER BY min(fecha_servidor) DESC LIMIT 200`);

const EXPORTES: Record<string, string> = {
  'movimientos': `SELECT m.id_mov, m.tipo, m.id_tarima, l.sku, l.num_lote, m.delta_cajas, m.pos_origen, m.pos_destino, m.es_fefo,
                         m.motivo_excepcion, m.justificacion, lp.num_lote AS lote_propuesto, m.id_pedido, m.renglon, m.id_usuario,
                         m.id_dispositivo, m.tarea, m.escaneos, m.fecha_dispositivo, m.fecha_servidor
                    FROM movimiento m LEFT JOIN lote l ON l.id_lote = m.id_lote LEFT JOIN lote lp ON lp.id_lote = m.id_lote_propuesto
                   ORDER BY m.fecha_servidor, m.fecha_dispositivo`,
  'eventos': `SELECT id, tipo, id_usuario, id_dispositivo, tarea, escaneos, resultado, detalle, fecha_dispositivo, fecha_servidor FROM evento ORDER BY id`,
  'bitacora': `SELECT id, entidad, operacion, valor_anterior, valor_nuevo, id_usuario, fecha_hora FROM bitacora ORDER BY id`,
};

export async function exportar(nombre: string): Promise<string | null> {
  const sql = EXPORTES[nombre];
  if (!sql) return null;
  const filas = await q<Record<string, unknown>>(sql);
  const columnas = filas.length ? Object.keys(filas[0]) : [];
  const celda = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columnas.join(','), ...filas.map((f) => columnas.map((c) => celda(f[c])).join(','))].join('\r\n');
}
