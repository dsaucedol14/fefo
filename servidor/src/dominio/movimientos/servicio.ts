/**
 * Movimientos (CU-02, CU-03, CU-05, CU-13): registra ubicaciones, reubicaciones y salidas como movimientos que la
 * base aplica (ADR-006). Recibe un lote de movimientos —de la cola del teléfono— y responde por cada uno:
 * aplicado, duplicado (mismo id_mov ya aplicado, RNF-03) o rechazado con su motivo. Cada movimiento es una
 * transacción. Los rechazos de una sincronización diferida quedan para revisión del supervisor (ADR-004).
 */
import { q, tx, uno } from '../../bd.js';
import { ErrorNegocio, traducir } from '../../errores.js';
import type { Usuario } from '../../seguridad/sesion.js';
import { generarLista } from '../surtido/servicio.js';

export interface MovimientoEntrada {
  id_mov: string;
  tipo: 'ubicacion' | 'reubicacion' | 'salida';
  id_tarima: string;
  id_lote?: string | null;
  cajas?: number;                 // positivo; la salida se registra con delta negativo
  pos_origen?: string | null;
  pos_destino?: string | null;
  motivo_excepcion?: string | null;
  justificacion?: string | null;
  id_pedido?: string | null;
  renglon?: number | null;
  id_reserva?: number | null;
  id_lote_propuesto?: string | null;
  fecha_dispositivo: string;
  tarea?: string | null;
  escaneos?: number | null;
}

export interface Resultado { id_mov: string; estado: 'aplicado' | 'duplicado' | 'rechazado'; codigo?: string; mensaje?: string; es_fefo?: boolean | null }

async function registrarUno(m: MovimientoEntrada, usuario: Usuario, idDispositivo: string | null): Promise<Resultado> {
  if (new Date(m.fecha_dispositivo).getTime() > Date.now() + 5 * 60_000) {
    throw new ErrorNegocio('hora_invalida', 'La hora del teléfono está adelantada; corrígela y vuelve a sincronizar.');
  }
  let delta = 0;
  if (m.tipo === 'salida') {
    if (!m.id_lote || !m.cajas || m.cajas <= 0) throw new ErrorNegocio('salida_incompleta', 'La salida necesita lote y cajas.');
    if (m.motivo_excepcion === 'decision_operador' && !m.justificacion?.trim()) {
      throw new ErrorNegocio('requiere_justificacion', 'Escribe la justificación de la decisión del operador.');
    }
    delta = -m.cajas;
  } else if (!m.pos_destino) {
    throw new ErrorNegocio('sin_destino', 'Escanea la posición destino.');
  }

  return tx(usuario.id_usuario, async (con) => {
    if (m.tipo === 'salida' && m.id_pedido) {
      // El renglón no puede surtirse de más ni con otro producto
      const linea = await uno<{ sku: string; cajas: number; cancelado: boolean }>(
        `SELECT lp.sku, lp.cajas, p.cancelado_en IS NOT NULL AS cancelado FROM linea_pedido lp JOIN pedido p USING (id_pedido)
          WHERE lp.id_pedido = $1 AND lp.renglon = $2 FOR UPDATE OF lp`, [m.id_pedido, m.renglon], con);
      if (!linea) throw new ErrorNegocio('renglon_inexistente', 'Ese renglón del pedido no existe.', 404);
      if (linea.cancelado) throw new ErrorNegocio('pedido_cancelado', 'El pedido fue cancelado.', 409);
      const ya = await uno<{ id_mov: string }>(`SELECT id_mov FROM movimiento WHERE id_mov = $1`, [m.id_mov], con);
      if (!ya) {
        const lote = await uno<{ sku: string }>(`SELECT sku FROM lote WHERE id_lote = $1`, [m.id_lote], con);
        if (lote && lote.sku !== linea.sku) throw new ErrorNegocio('otro_producto', 'Ese lote es de otro producto.', 409);
        const [{ surtidas }] = await q<{ surtidas: number }>(
          `SELECT COALESCE(-sum(delta_cajas), 0)::int AS surtidas FROM movimiento WHERE id_pedido = $1 AND renglon = $2 AND tipo = 'salida'`,
          [m.id_pedido, m.renglon], con);
        if (surtidas + (m.cajas ?? 0) > linea.cajas) {
          throw new ErrorNegocio('renglon_completo', `Al renglón solo le faltan ${linea.cajas - surtidas} cajas.`, 409);
        }
      }
    }
    const r = await con.query<{ es_fefo: boolean | null }>(
      `INSERT INTO movimiento (id_mov, tipo, id_tarima, id_lote, delta_cajas, pos_origen, pos_destino, motivo_excepcion, justificacion,
                               id_pedido, renglon, id_reserva, id_lote_propuesto, id_usuario, id_dispositivo, fecha_dispositivo, tarea, escaneos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING es_fefo`,
      [m.id_mov, m.tipo, m.id_tarima, m.id_lote ?? null, delta, m.tipo === 'ubicacion' ? null : (m.pos_origen ?? null),
        m.pos_destino ?? null, m.motivo_excepcion ?? null, m.justificacion?.trim() || null, m.id_pedido ?? null, m.renglon ?? null,
        m.id_reserva ?? null, m.id_lote_propuesto ?? null, usuario.id_usuario, idDispositivo, m.fecha_dispositivo,
        m.tarea ?? null, m.escaneos ?? null]);
    // El disparador devuelve NULL si el id_mov ya existía: reenvío idempotente (PI-16)
    if (r.rowCount === 0) return { id_mov: m.id_mov, estado: 'duplicado' as const };
    return { id_mov: m.id_mov, estado: 'aplicado' as const, es_fefo: r.rows[0].es_fefo };
  });
}

export async function registrar(movs: MovimientoEntrada[], usuario: Usuario, idDispositivo: string | null, diferido: boolean): Promise<Resultado[]> {
  const resultados: Resultado[] = [];
  const pedidos = new Set<string>();
  for (const m of movs) {
    try {
      resultados.push(await registrarUno(m, usuario, idDispositivo));
      if (m.id_pedido) pedidos.add(m.id_pedido);
    } catch (e) {
      const err = traducir(e);
      if (!err) throw e;
      resultados.push({ id_mov: m.id_mov, estado: 'rechazado', codigo: err.codigo, mensaje: err.message });
      // ADR-004: lo rechazado al sincronizar pasa a revisión del supervisor
      await q(`INSERT INTO evento (tipo, id_usuario, id_dispositivo, tarea, escaneos, resultado, detalle, fecha_dispositivo)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [diferido ? 'rechazo_sync' : 'rechazo', usuario.id_usuario, idDispositivo, m.tarea ?? null, m.escaneos ?? null, err.codigo,
          JSON.stringify({ movimiento: m, mensaje: err.message }), m.fecha_dispositivo]);
    }
  }
  if (idDispositivo) await q(`UPDATE dispositivo SET ultima_sync = now() WHERE id_dispositivo = $1`, [idDispositivo]);
  // Completa las listas de surtido de los pedidos tocados (las reservas liberadas se reasignan)
  for (const p of pedidos) await generarLista(p, usuario);
  return resultados;
}
