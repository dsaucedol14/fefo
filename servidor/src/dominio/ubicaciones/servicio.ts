/**
 * Ubicaciones (CU-02, CU-04): RF-05 parcial (sugerir posición compatible con RN-05 y, en piso, la caducidad más
 * lejana al fondo), RF-07 profundidad y bloqueo, RF-09 localizar por código, nombre o escaneo. Mapa de ocupación.
 */
import { hoy, q, uno } from '../../bd.js';
import { ErrorNegocio } from '../../errores.js';
import { bloqueos } from '../../repositorios/inventario.js';
import { diasEntre, umbral } from '../fefo/motor.js';

export async function tarima(id: string) {
  const t = await uno<{ id_tarima: string; id_posicion: string | null; estado: string; fecha_recepcion: string; zona: string | null; tipo: string | null;
    fila: string | null; profundidad: number | null; es_fria: boolean | null }>(
    `SELECT t.id_tarima, t.id_posicion, t.estado, t.fecha_recepcion::text, z.codigo AS zona, z.tipo, p.fila, p.profundidad, z.es_fria
       FROM tarima t LEFT JOIN posicion p USING (id_posicion) LEFT JOIN zona z USING (id_zona) WHERE t.id_tarima = $1`, [id]);
  if (!t) throw new ErrorNegocio('tarima_inexistente', `No hay ninguna tarima ${id}. Revisa la etiqueta.`, 404);
  const lotes = await q(
    `SELECT tl.id_lote, l.num_lote, l.sku, p.nombre AS producto, p.requiere_frio, tl.cajas, l.estado,
            l.fecha_caducidad, l.caducidad_efectiva, COALESCE(l.caducidad_efectiva, l.fecha_caducidad) AS caducidad_vigente
       FROM tarima_lote tl JOIN lote l USING (id_lote) JOIN producto p USING (sku)
      WHERE tl.id_tarima = $1 AND tl.cajas > 0 ORDER BY caducidad_vigente`, [id]);
  const movimientos = await q(
    `SELECT m.tipo, m.delta_cajas, m.pos_origen, m.pos_destino, m.es_fefo, m.motivo_excepcion, l.num_lote, m.id_usuario,
            m.fecha_dispositivo::text, m.fecha_servidor::text
       FROM movimiento m LEFT JOIN lote l USING (id_lote) WHERE m.id_tarima = $1 ORDER BY m.fecha_servidor DESC LIMIT 40`, [id]);
  const b = (await bloqueos([id])).get(id);
  return { ...t, lotes, movimientos, tarimas_delante: b?.tarimas_delante ?? 0, bloqueada_por: b?.bloqueada_por ?? [] };
}

/** Posición actual de cada tarima activa: el teléfono la guarda para registrar reubicaciones sin red (RNF-03). */
export async function posiciones() {
  return q(`SELECT id_tarima, id_posicion, estado FROM tarima WHERE estado <> 'vacia'`);
}

/**
 * RF-05 (parcial): posiciones libres compatibles con RN-05. En piso solo se ofrecen lugares alcanzables (todas las
 * posiciones delante libres) y, de ellos, el más profundo de cada fila. Lo de caducidad lejana se manda al fondo;
 * lo próximo a caducar, a rack o al frente.
 */
export async function sugerir(idTarima: string) {
  const t = await tarima(idTarima);
  if (t.estado === 'vacia') throw new ErrorNegocio('tarima_vacia', 'La tarima ya salió del almacén.', 409);
  if (!t.lotes.length) throw new ErrorNegocio('tarima_sin_lotes', 'La tarima no tiene lotes.', 409);
  const frio = t.lotes.some((l) => (l as { requiere_frio: boolean }).requiere_frio);
  const fecha = await hoy();
  const cat = await uno<{ vu_dias: number; vmr_dias: number; tr_dias: number; ms_dias: number }>(
    `SELECT c.vu_dias, c.vmr_dias, c.tr_dias, c.ms_dias FROM producto p JOIN categoria c USING (id_categoria) WHERE p.sku = $1`,
    [(t.lotes[0] as { sku: string }).sku]);
  const dias = Math.min(...t.lotes.map((l) => diasEntre(fecha, (l as { caducidad_vigente: string }).caducidad_vigente)));
  const lejana = cat ? dias > 2 * umbral(cat) : true;

  const libres = await q<{ id_posicion: string; zona: string; tipo: string; fila: string | null; profundidad: number }>(
    `SELECT p.id_posicion, z.codigo AS zona, z.tipo, p.fila, p.profundidad
       FROM posicion p JOIN zona z USING (id_zona)
      WHERE p.activa AND z.es_fria = $1
        AND NOT EXISTS (SELECT 1 FROM tarima t WHERE t.id_posicion = p.id_posicion)
        AND (p.fila IS NULL OR NOT EXISTS (SELECT 1 FROM posicion p2 JOIN tarima t2 ON t2.id_posicion = p2.id_posicion
                                            WHERE p2.fila = p.fila AND p2.profundidad < p.profundidad))
      ORDER BY p.id_posicion`, [frio]);
  // En cada fila de piso, el lugar alcanzable más profundo
  const piso = new Map<string, typeof libres[number]>();
  for (const l of libres.filter((x) => x.fila)) {
    const actual = piso.get(l.fila!);
    if (!actual || l.profundidad > actual.profundidad) piso.set(l.fila!, l);
  }
  const rack = libres.filter((x) => !x.fila);
  const fondo = [...piso.values()].sort((a, b) => b.profundidad - a.profundidad || a.id_posicion.localeCompare(b.id_posicion));
  const orden = frio ? rack : lejana ? [...fondo, ...rack] : [...rack, ...fondo.slice().reverse()];
  return {
    id_tarima: idTarima, requiere_frio: frio, dias_minimos: dias,
    criterio: frio ? 'Refrigerado: solo cámara fría (RN-05).'
      : lejana ? 'Caducidad lejana: al fondo de una fila de piso (RN-05).' : 'Caducidad próxima: en rack o al frente, donde se alcance sin mover tarimas.',
    posiciones: orden.slice(0, 6),
  };
}

/**
 * RF-09: busca por ID de tarima (completo o últimos dígitos), posición, lote, SKU o nombre. Con gtin/lote (código
 * GS1 de la caja, leído en el teléfono) busca ese lote. Marca el candidato FEFO de cada producto (v_candidato_fefo).
 */
export async function buscar(p: { q?: string; gtin?: string; lote?: string }) {
  const texto = (p.q ?? '').trim();
  const exacto = texto.replace(/\s+/g, '').toUpperCase();
  if (!p.gtin && texto.length < 2) return { tipo: 'vacio', resultados: [] };
  if (!p.gtin) {
    const t = /^\d{4,18}$/.test(exacto)
      ? await q<{ id_tarima: string }>(`SELECT id_tarima FROM tarima WHERE id_tarima = lpad($1, 18, '0') OR id_tarima LIKE '%' || $1 LIMIT 2`, [exacto])
      : [];
    if (t.length === 1) return { tipo: 'tarima', id_tarima: t[0].id_tarima, resultados: [] };
    const enPos = await uno<{ id_tarima: string }>(`SELECT id_tarima FROM tarima WHERE id_posicion = $1`, [exacto]);
    if (enPos) return { tipo: 'tarima', id_tarima: enPos.id_tarima, resultados: [] };
  }
  let filtro: string;
  let params: unknown[];
  if (p.gtin) {
    const claves = p.gtin.startsWith('0') ? [p.gtin, p.gtin.slice(1)] : [p.gtin];
    filtro = p.lote ? 'e.sku = ANY($1) AND e.num_lote = $2' : 'e.sku = ANY($1)';
    params = p.lote ? [claves, p.lote.toUpperCase()] : [claves];
  } else {
    filtro = '(e.num_lote = $1 OR e.sku = $1 OR pr.nombre ILIKE $2)';
    params = [exacto, `%${texto.replace(/[\\%_]/g, '\\$&')}%`];
  }
  const resultados = await q(
    `SELECT e.id_lote, e.num_lote, e.sku, pr.nombre AS producto, e.caducidad_vigente, e.id_tarima, e.id_posicion,
            z.codigo AS zona, po.fila, po.profundidad, e.cajas, l.estado,
            COALESCE(b.tarimas_delante, 0)::int AS tarimas_delante, b.bloqueada_por,
            (c.id_lote = e.id_lote) AS es_candidato_fefo, (e.caducidad_vigente - current_date) AS dias_restantes
       FROM v_existencia e JOIN producto pr USING (sku) JOIN lote l USING (id_lote)
       LEFT JOIN posicion po ON po.id_posicion = e.id_posicion LEFT JOIN zona z ON z.id_zona = po.id_zona
       LEFT JOIN v_bloqueo b USING (id_tarima)
       LEFT JOIN v_candidato_fefo c ON c.sku = e.sku
      WHERE ${filtro}
      ORDER BY pr.nombre, e.caducidad_vigente, e.fecha_recepcion, COALESCE(b.tarimas_delante, 0)
      LIMIT 100`, params);
  return { tipo: 'lotes', resultados };
}

/** Mapa: cada posición con su tarima y el peor nivel de alerta de sus lotes (v_alerta). */
export async function mapa() {
  // v_alerta se evalúa una sola vez (antes, una vez por posición: ~1 s con 5 000 lotes)
  return q(
    `WITH peor AS (
       SELECT tl.id_tarima, (array_agg(a.nivel ORDER BY array_position(ARRAY['vencido','critico','alto','preventivo'], a.nivel)))[1] AS nivel
         FROM tarima_lote tl JOIN v_alerta a USING (id_lote)
        WHERE tl.cajas > 0 AND a.nivel IS NOT NULL GROUP BY tl.id_tarima)
     SELECT p.id_posicion, z.codigo AS zona, z.tipo, z.es_fria, p.fila, p.profundidad, t.id_tarima, peor.nivel
       FROM posicion p JOIN zona z USING (id_zona) LEFT JOIN tarima t ON t.id_posicion = p.id_posicion
       LEFT JOIN peor ON peor.id_tarima = t.id_tarima
      WHERE p.activa ORDER BY z.codigo, p.id_posicion`);
}
