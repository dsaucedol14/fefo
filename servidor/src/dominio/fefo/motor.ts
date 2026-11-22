/**
 * Motor de reglas FEFO restringido por accesibilidad (P3 VI.D, ADR-005). Función pura: no consulta la base
 * ni la red; recibe el inventario vigente, la accesibilidad calculada por v_bloqueo y los parámetros.
 *   RN-01  caducidad vigente → recepción más antigua → menos tarimas delante
 *   RN-02  lo caducado no es candidato
 *   C1     el lote FEFO bloqueado se declara con las tarimas que lo bloquean y una alternativa accesible;
 *          nunca se sustituye en silencio
 *   RN-07  niveles de alerta con U(c) y criterio por rotación
 */

export interface Candidato {
  id_lote: string;
  num_lote: string;
  id_tarima: string;
  id_posicion: string | null;
  caducidad_vigente: string;     // AAAA-MM-DD (efectiva si existe, si no la impresa)
  fecha_recepcion: string;       // AAAA-MM-DD
  saldo: number;                 // cajas libres: saldo de la tarima-lote menos reservas abiertas (CF2)
  tarimas_delante: number;
  bloqueada_por: string[];
}

export interface Alternativa {
  candidato: Candidato;
  dias_de_diferencia: number;
}

export interface LineaRecomendada {
  lote: Candidato;
  cajas: number;
  bloqueado_por: number;
  tarimas: string[];
  alternativa: Alternativa | null;
}

export interface Recomendacion {
  lineas: LineaRecomendada[];
  faltante: number;
}

/** Días naturales de a a b (b − a) para fechas AAAA-MM-DD. */
export function diasEntre(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/** Orden de RN-01; el identificador de tarima solo vuelve determinista el empate total. */
export function compararFefo(a: Candidato, b: Candidato): number {
  return a.caducidad_vigente.localeCompare(b.caducidad_vigente)
    || a.fecha_recepcion.localeCompare(b.fecha_recepcion)
    || a.tarimas_delante - b.tarimas_delante
    || a.id_tarima.localeCompare(b.id_tarima);
}

/**
 * Candidatos elegibles para surtir: saldo libre, vigentes a la fecha (RN-02) y en una tarima ubicada (RF-06:
 * una tarima «por ubicar» no está disponible). Ordenados por RN-01.
 */
export function elegibles(candidatos: Candidato[], hoy: string): Candidato[] {
  return candidatos
    .filter((c) => c.saldo > 0 && c.id_posicion !== null && c.caducidad_vigente >= hoy)
    .sort(compararFefo);
}

/** Primer candidato accesible (sin tarimas delante) distinto del elegido, para un lote FEFO bloqueado. */
export function alternativaAccesible(ordenados: Candidato[], elegido: Candidato): Alternativa | null {
  if (elegido.tarimas_delante === 0) return null;
  const alt = ordenados.find((c) => c.tarimas_delante === 0
    && !(c.id_lote === elegido.id_lote && c.id_tarima === elegido.id_tarima));
  return alt ? { candidato: alt, dias_de_diferencia: diasEntre(elegido.caducidad_vigente, alt.caducidad_vigente) } : null;
}

/** recomendar(sku, cajas, hoy, inventario) de P3 VI.D. */
export function recomendar(cajas: number, hoy: string, inventario: Candidato[]): Recomendacion {
  const ordenados = elegibles(inventario, hoy);
  const lineas: LineaRecomendada[] = [];
  let resta = cajas;
  for (const c of ordenados) {
    if (resta <= 0) break;
    const tomar = Math.min(resta, c.saldo);
    lineas.push({ lote: c, cajas: tomar, bloqueado_por: c.tarimas_delante, tarimas: c.bloqueada_por,
      alternativa: alternativaAccesible(ordenados, c) });
    resta -= tomar;
  }
  return { lineas, faltante: Math.max(0, resta) };
}

/**
 * Definición de conformidad que usa la base al registrar una salida (tg_aplica_movimiento): es FEFO si no hay
 * otro lote vigente del producto, con saldo y disponible, que caduque estrictamente antes. Se replica aquí para
 * la prueba de concordancia motor–base (PU-05).
 */
export function esFefo(caducidadElegido: string, existencias: Array<{ caducidad_vigente: string; cajas: number }>, hoy: string): boolean {
  return !existencias.some((e) => e.cajas > 0 && e.caducidad_vigente >= hoy && e.caducidad_vigente < caducidadElegido);
}

export type Nivel = 'vencido' | 'critico' | 'alto' | 'preventivo';

/** U(c) = mín{VU, VMR + TR + MS} (P1 V.G). */
export function umbral(c: { vu_dias: number; vmr_dias: number; tr_dias: number; ms_dias: number }): number {
  return Math.min(c.vu_dias, c.vmr_dias + c.tr_dias + c.ms_dias);
}

/** Tabla VIII de P1: vencido d < 0; crítico d ≤ U/4; alto d ≤ U/2; preventivo d ≤ U. */
export function nivelAlerta(d: number, U: number): Nivel | null {
  if (d < 0) return 'vencido';
  if (d <= U / 4) return 'critico';
  if (d <= U / 2) return 'alto';
  if (d <= U) return 'preventivo';
  return null;
}

/** Criterio por rotación (P2 VII.E): R < Q / d̄ + VMR + TR. Sin demanda registrada no aplica. */
export function riesgoRotacion(R: number, Q: number, demanda: number, vmr: number, tr: number): boolean {
  return demanda > 0 && Q > 0 && R < Q / demanda + vmr + tr;
}

/**
 * RN-03: se acepta un lote si días restantes ≥ cobertura esperada + VMR(c); la cobertura es Q / d̄ y, sin demanda
 * registrada, TR(c). Vencido → rechazo; bajo el mínimo → requiere autorización de un supervisor.
 */
export function evaluarRecepcion(p: { caducidad: string; hoy: string; cajas: number; demanda: number; vmr: number; tr: number }):
  { estado: 'ok' | 'autorizar' | 'rechazar'; dias: number; minimo: number } {
  const dias = diasEntre(p.hoy, p.caducidad);
  if (dias < 0) return { estado: 'rechazar', dias, minimo: 0 };
  const cobertura = p.demanda > 0 ? p.cajas / p.demanda : p.tr;
  const minimo = Math.ceil(cobertura + p.vmr);
  return { estado: dias >= minimo ? 'ok' : 'autorizar', dias, minimo };
}
