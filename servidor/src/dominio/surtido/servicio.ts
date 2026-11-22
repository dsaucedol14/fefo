/**
 * Surtido (CU-05): RF-11 lista con el lote FEFO reservado por renglón (CF2), su posición, el bloqueo y la
 * alternativa accesible (C1); el motor FEFO decide (ADR-005) y la base vuelve a verificar es_fefo en la salida.
 * El estado del pedido se deriva de sus salidas (P3 no le da columna de estado).
 */
import { hoy, q, tx, uno } from '../../bd.js';
import { ErrorNegocio, traducir } from '../../errores.js';
import type { Usuario } from '../../seguridad/sesion.js';
import { candidatos } from '../../repositorios/inventario.js';
import { alternativaAccesible, elegibles, recomendar } from '../fefo/motor.js';

/** Completa las reservas de cada renglón con lo que falta, en orden RN-01. Serializado con un candado consultivo. */
export async function generarLista(idPedido: string, usuario: Usuario) {
  await tx(usuario.id_usuario, async (con) => {
    await con.query(`SELECT pg_advisory_xact_lock(hashtext('fefo-surtido'))`);
    const ped = await uno<{ cancelado_en: string | null }>(`SELECT cancelado_en FROM pedido WHERE id_pedido = $1`, [idPedido], con);
    if (!ped) throw new ErrorNegocio('pedido_inexistente', 'Ese pedido no existe.', 404);
    if (ped.cancelado_en) return;
    const fecha = await hoy(con);
    const lineas = await q<{ renglon: number; sku: string; cajas: number; id_lote_reservado: string | null; pendiente: number }>(
      `SELECT lp.renglon, lp.sku, lp.cajas, lp.id_lote_reservado,
              lp.cajas - COALESCE((SELECT -sum(delta_cajas) FROM movimiento m WHERE m.id_pedido = lp.id_pedido AND m.renglon = lp.renglon AND m.tipo = 'salida'), 0)
                       - COALESCE((SELECT sum(cajas) FROM reserva r WHERE r.id_pedido = lp.id_pedido AND r.renglon = lp.renglon AND r.estado = 'abierta'), 0) AS pendiente
         FROM linea_pedido lp WHERE lp.id_pedido = $1 ORDER BY lp.renglon`, [idPedido], con);
    for (const l of lineas) {
      if (l.pendiente <= 0) continue;
      const r = recomendar(l.pendiente, fecha, await candidatos(l.sku, con));
      for (const x of r.lineas) {
        await q(`INSERT INTO reserva (id_pedido, renglon, id_lote, id_tarima, cajas) VALUES ($1, $2, $3, $4, $5)`,
          [idPedido, l.renglon, x.lote.id_lote, x.lote.id_tarima, x.cajas], con);
      }
      if (!l.id_lote_reservado && r.lineas[0]) {
        await q(`UPDATE linea_pedido SET id_lote_reservado = $3 WHERE id_pedido = $1 AND renglon = $2`, [idPedido, l.renglon, r.lineas[0].lote.id_lote], con);
      }
    }
  });
}

/** Lista de surtido para la pantalla: por renglón, sus reservas abiertas con posición, bloqueo y alternativa. */
export async function lista(idPedido: string) {
  const ped = await uno<{ id_pedido: string; fecha: string; cliente_ref: string | null; cancelado_en: string | null }>(
    `SELECT id_pedido, fecha::text, cliente_ref, cancelado_en::text FROM pedido WHERE id_pedido = $1`, [idPedido]);
  if (!ped) throw new ErrorNegocio('pedido_inexistente', 'Ese pedido no existe.', 404);
  const fecha = await hoy();
  const lineas = await q<{ renglon: number; sku: string; producto: string; cajas: number; surtidas: number }>(
    `SELECT lp.renglon, lp.sku, p.nombre AS producto, lp.cajas,
            COALESCE((SELECT -sum(delta_cajas) FROM movimiento m WHERE m.id_pedido = lp.id_pedido AND m.renglon = lp.renglon AND m.tipo = 'salida'), 0)::int AS surtidas
       FROM linea_pedido lp JOIN producto p USING (sku) WHERE lp.id_pedido = $1 ORDER BY lp.renglon`, [idPedido]);
  const reservas = await q<{ id_reserva: number; renglon: number; id_lote: string; id_tarima: string; cajas: number; num_lote: string;
    caducidad_vigente: string; id_posicion: string | null; zona: string | null; fila: string | null; profundidad: number | null;
    tarimas_delante: number; bloqueada_por: string | null }>(
    `SELECT r.id_reserva, r.renglon, r.id_lote, r.id_tarima, r.cajas, l.num_lote,
            COALESCE(l.caducidad_efectiva, l.fecha_caducidad) AS caducidad_vigente, t.id_posicion, z.codigo AS zona, po.fila, po.profundidad,
            COALESCE(b.tarimas_delante, 0)::int AS tarimas_delante, b.bloqueada_por
       FROM reserva r JOIN lote l USING (id_lote) JOIN tarima t ON t.id_tarima = r.id_tarima
       LEFT JOIN posicion po ON po.id_posicion = t.id_posicion LEFT JOIN zona z ON z.id_zona = po.id_zona
       LEFT JOIN v_bloqueo b ON b.id_tarima = r.id_tarima
      WHERE r.id_pedido = $1 AND r.estado = 'abierta' ORDER BY r.renglon, r.id_reserva`, [idPedido]);
  const salidas = await q(
    `SELECT m.renglon, m.id_tarima, l.num_lote, lp.num_lote AS num_lote_propuesto, -m.delta_cajas AS cajas, m.es_fefo, m.motivo_excepcion,
            m.id_usuario, m.fecha_dispositivo::text
       FROM movimiento m LEFT JOIN lote l ON l.id_lote = m.id_lote LEFT JOIN lote lp ON lp.id_lote = m.id_lote_propuesto
      WHERE m.id_pedido = $1 AND m.tipo = 'salida' ORDER BY m.fecha_servidor`, [idPedido]);

  const porSku = new Map<string, Awaited<ReturnType<typeof candidatos>>>();
  const renglones = [];
  for (const l of lineas) {
    if (!porSku.has(l.sku)) porSku.set(l.sku, await candidatos(l.sku));
    // Para la alternativa se cuentan también las cajas que esta lista ya reservó
    const propias = reservas.filter((r) => r.renglon === l.renglon);
    const inventario = porSku.get(l.sku)!.map((c) => ({ ...c, saldo: c.saldo + propias.filter((r) => r.id_lote === c.id_lote && r.id_tarima === c.id_tarima).reduce((s, r) => s + r.cajas, 0) }));
    const ordenados = elegibles(inventario, fecha);
    const items = propias.map((r) => {
      const c = ordenados.find((x) => x.id_lote === r.id_lote && x.id_tarima === r.id_tarima);
      const alt = c ? alternativaAccesible(ordenados, c) : null;
      return {
        ...r, bloqueada_por: r.bloqueada_por ? r.bloqueada_por.split(',') : [],
        dias_restantes: Math.round((Date.parse(r.caducidad_vigente) - Date.parse(fecha)) / 86_400_000),
        alternativa: alt && {
          id_lote: alt.candidato.id_lote, num_lote: alt.candidato.num_lote, id_tarima: alt.candidato.id_tarima,
          id_posicion: alt.candidato.id_posicion, caducidad_vigente: alt.candidato.caducidad_vigente, dias_de_diferencia: alt.dias_de_diferencia,
        },
      };
    });
    const reservado = items.reduce((s, r) => s + r.cajas, 0);
    renglones.push({ ...l, reservas: items, faltante: Math.max(0, l.cajas - l.surtidas - reservado) });
  }
  const completo = renglones.every((r) => r.surtidas >= r.cajas);
  return { ...ped, estado: ped.cancelado_en ? 'cancelado' : completo ? 'surtido' : 'abierto', renglones, salidas };
}

export async function pedidos() {
  return q(
    `SELECT p.id_pedido, p.fecha::text, p.cliente_ref, p.cancelado_en IS NOT NULL AS cancelado,
            count(lp.*)::int AS renglones, COALESCE(sum(lp.cajas), 0)::int AS cajas,
            COALESCE((SELECT -sum(delta_cajas) FROM movimiento m WHERE m.id_pedido = p.id_pedido AND m.tipo = 'salida'), 0)::int AS surtidas
       FROM pedido p LEFT JOIN linea_pedido lp USING (id_pedido)
      GROUP BY p.id_pedido ORDER BY p.cancelado_en IS NOT NULL, p.fecha DESC, p.id_pedido DESC LIMIT 100`);
}

export async function crearPedido(p: { cliente_ref?: string; lineas: Array<{ sku: string; cajas: number }> }, usuario: Usuario) {
  const skus = new Set<string>();
  for (const l of p.lineas) {
    if (skus.has(l.sku)) throw new ErrorNegocio('renglon_repetido', `El producto ${l.sku} está repetido; súmalo en un solo renglón.`);
    skus.add(l.sku);
  }
  try {
    const id = await tx(usuario.id_usuario, async (con) => {
      await con.query(`SELECT pg_advisory_xact_lock(hashtext('fefo-folio-pedido'))`);
      const [{ folio }] = await q<{ folio: string }>(
        `SELECT 'PED-' || to_char(current_date, 'YYYY') || '-' ||
                lpad((COALESCE(max(substring(id_pedido FROM '\\d+$')::int) FILTER (WHERE id_pedido LIKE 'PED-' || to_char(current_date, 'YYYY') || '-%'), 0) + 1)::text, 4, '0') AS folio
           FROM pedido`, [], con);
      await q(`INSERT INTO pedido (id_pedido, fecha, cliente_ref) VALUES ($1, current_date, $2)`, [folio, p.cliente_ref?.trim() || null], con);
      for (const [i, l] of p.lineas.entries()) {
        await q(`INSERT INTO linea_pedido (id_pedido, renglon, sku, cajas) VALUES ($1, $2, $3, $4)`, [folio, i + 1, l.sku, l.cajas], con);
      }
      return folio;
    });
    await generarLista(id, usuario);
    return lista(id);
  } catch (e) {
    throw traducir(e) ?? e;
  }
}

export async function cancelar(idPedido: string, usuario: Usuario) {
  await tx(usuario.id_usuario, async (con) => {
    const r = await con.query(`UPDATE pedido SET cancelado_en = now() WHERE id_pedido = $1 AND cancelado_en IS NULL`, [idPedido]);
    if (!r.rowCount) throw new ErrorNegocio('pedido_inexistente', 'El pedido no existe o ya estaba cancelado.', 404);
    await con.query(`UPDATE reserva SET estado = 'liberada' WHERE id_pedido = $1 AND estado = 'abierta'`, [idPedido]);
  });
}
