/**
 * Alertas (CU-07): RF-14 con RN-07 sobre la vista v_alerta de P3 (umbral U(c) por categoría y criterio por
 * rotación); cada lote trae sus tarimas, posición y bloqueo (v_bloqueo). RF-16: propuesta de baja de lo vencido.
 */
import { q, uno } from '../../bd.js';
import { ErrorNegocio, traducir } from '../../errores.js';
import type { Usuario } from '../../seguridad/sesion.js';

export async function alertas() {
  const filas = await q<{ id_lote: string; nivel: string | null; riesgo_rotacion: boolean | null } & Record<string, unknown>>(
    `SELECT a.id_lote, a.sku, p.nombre AS producto, c.nombre AS categoria, l.num_lote, a.cad AS caducidad_vigente, a.dias_restantes,
            a.umbral_dias, a.cajas::int AS cajas, a.nivel, COALESCE(a.riesgo_rotacion, false) AS riesgo_rotacion,
            json_agg(json_build_object('id_tarima', tl.id_tarima, 'cajas', tl.cajas, 'id_posicion', t.id_posicion,
                                       'profundidad', po.profundidad, 'tarimas_delante', COALESCE(b.tarimas_delante, 0),
                                       'bloqueada_por', b.bloqueada_por) ORDER BY po.profundidad) AS tarimas
       FROM v_alerta a JOIN lote l USING (id_lote) JOIN producto p ON p.sku = a.sku JOIN categoria c ON c.id_categoria = p.id_categoria
       JOIN tarima_lote tl ON tl.id_lote = a.id_lote AND tl.cajas > 0 JOIN tarima t ON t.id_tarima = tl.id_tarima
       LEFT JOIN posicion po ON po.id_posicion = t.id_posicion LEFT JOIN v_bloqueo b ON b.id_tarima = t.id_tarima
      WHERE a.nivel IS NOT NULL OR a.riesgo_rotacion
      GROUP BY a.id_lote, a.sku, p.nombre, c.nombre, l.num_lote, a.cad, a.dias_restantes, a.umbral_dias, a.cajas, a.nivel, a.riesgo_rotacion
      ORDER BY array_position(ARRAY['vencido','critico','alto','preventivo'], a.nivel) NULLS LAST, a.dias_restantes`);
  const bajas = await q(
    `SELECT b.id_baja, b.id_tarima, b.cajas, b.motivo, b.estado, b.registrado_por, l.num_lote, p.nombre AS producto
       FROM baja b JOIN lote l USING (id_lote) JOIN producto p USING (sku) WHERE b.estado = 'pendiente' ORDER BY l.num_lote`);
  const conteo = { vencido: 0, critico: 0, alto: 0, preventivo: 0, rotacion: 0, bloqueados: 0 };
  for (const a of filas) {
    if (a.nivel) conteo[a.nivel as 'vencido']++;
    if (a.riesgo_rotacion) conteo.rotacion++;
    if (a.nivel && a.nivel !== 'vencido' && (a.tarimas as Array<{ tarimas_delante: number }>).some((t) => t.tarimas_delante > 0)) conteo.bloqueados++;
  }
  return { conteo, alertas: filas, bajas };
}

/** RF-16: baja pendiente de un lote vencido (o dañado / con ruptura de frío). No descuenta hasta autorizarse (RF-17). */
export async function proponerBaja(p: { id_lote: string; id_tarima: string; motivo: string }, usuario: Usuario) {
  const tl = await uno<{ cajas: number; vencido: boolean; num_lote: string }>(
    `SELECT tl.cajas, COALESCE(l.caducidad_efectiva, l.fecha_caducidad) < current_date AS vencido, l.num_lote
       FROM tarima_lote tl JOIN lote l USING (id_lote) WHERE tl.id_tarima = $1 AND tl.id_lote = $2 AND tl.cajas > 0`, [p.id_tarima, p.id_lote]);
  if (!tl) throw new ErrorNegocio('lote_no_en_tarima', 'Ese lote no está en la tarima.', 404);
  if (p.motivo === 'caducidad' && !tl.vencido) throw new ErrorNegocio('no_vencido', `El lote ${tl.num_lote} aún no caduca.`, 409);
  const ya = await uno(`SELECT 1 FROM baja WHERE id_lote = $1 AND id_tarima = $2 AND estado = 'pendiente'`, [p.id_lote, p.id_tarima]);
  if (ya) return { estado: 'ya_propuesta', num_lote: tl.num_lote };
  try {
    const [b] = await q(`INSERT INTO baja (id_lote, id_tarima, cajas, motivo, registrado_por) VALUES ($1, $2, $3, $4, $5) RETURNING id_baja, estado`,
      [p.id_lote, p.id_tarima, tl.cajas, p.motivo, usuario.id_usuario]);
    return { ...b, num_lote: tl.num_lote, cajas: tl.cajas };
  } catch (e) {
    throw traducir(e) ?? e;
  }
}
