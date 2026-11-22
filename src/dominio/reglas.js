/**
 * Reglas de negocio de P2 como funciones puras (sin base de datos), para probarlas con casos límite.
 *   RN-01 FEFO con desempates · RN-02 caducados no disponibles · RN-03 aceptación por vida remanente
 *   RN-07 niveles de alerta con U(c) y criterio por rotación (Sección VII.E) · C1 bloqueo por accesibilidad
 */
const { diasEntre } = require('../util');

/** Caducidad que manda: la efectiva (si se rompió la cadena de frío) o la impresa. */
function caducidadDe(lote) {
  return lote.caducidad_efectiva || lote.fecha_caducidad;
}

/** RN-02: un lote con caducidad anterior a hoy no está disponible para salida. El día de la caducidad sí. */
function caducado(lote, hoy) {
  return diasEntre(hoy, caducidadDe(lote)) < 0;
}

/**
 * RN-01: caducidad más próxima; si empatan, recepción más antigua; si empatan, menor profundidad.
 * El último desempate por tarima solo hace el orden determinista.
 */
function compararFefo(a, b) {
  return caducidadDe(a).localeCompare(caducidadDe(b))
    || String(a.fecha_recepcion).localeCompare(String(b.fecha_recepcion))
    || (a.profundidad || 1) - (b.profundidad || 1)
    || String(a.id_tarima).localeCompare(String(b.id_tarima));
}

/**
 * Asigna `cajas` de un producto entre los candidatos (lote en tarima) siguiendo RN-01.
 * Solo cuentan los elegibles: no caducados, ubicados (RF-06) y con cajas libres (descontadas las reservas, CF2).
 * La inaccesibilidad NO cambia la prioridad (C1): el bloqueo se informa, no se salta el lote.
 * Devuelve { partidas: [{...candidato, cajas}], faltante }.
 */
function asignarFefo(candidatos, cajas, hoy) {
  const elegibles = candidatos
    .filter((c) => c.id_posicion && c.libres > 0 && !caducado(c, hoy))
    .sort(compararFefo);
  const partidas = [];
  let resta = cajas;
  for (const c of elegibles) {
    if (resta <= 0) break;
    const toma = Math.min(resta, c.libres);
    partidas.push({ ...c, cajas: toma });
    resta -= toma;
  }
  return { partidas, faltante: resta };
}

/** Lote FEFO (el primero elegible) de un conjunto de candidatos, o null. */
function loteFefo(candidatos, hoy) {
  const elegibles = candidatos.filter((c) => c.id_posicion && !caducado(c, hoy)).sort(compararFefo);
  return elegibles[0] || null;
}

/**
 * Umbral U(c) = mín{VU(c), VMR(c) + TR(c) + MS(c)} (P1 V.G). Si falta VMR, TR o MS se usa el valor por omisión
 * (30 días) y se marca como supuesto.
 */
function umbral(categoria, omision = 30) {
  const { vu_dias: vu, vmr_dias: vmr, tr_dias: tr, ms_dias: ms } = categoria || {};
  if ([vmr, tr, ms].some((v) => v === null || v === undefined)) {
    return { U: vu ? Math.min(vu, omision) : omision, supuesto: true };
  }
  const suma = vmr + tr + ms;
  return { U: vu ? Math.min(vu, suma) : suma, supuesto: false };
}

/** Nivel de alerta por días restantes d (Tabla VIII de P1). null = sin alerta. */
function nivelAlerta(d, U) {
  if (d < 0) return 'VENCIDO';
  if (d <= U / 4) return 'CRITICO';
  if (d <= U / 2) return 'ALTO';
  if (d <= U) return 'PREVENTIVO';
  return null;
}

/**
 * Criterio por rotación: R < Q / d̄ + VMR + TR. Sin demanda registrada (d̄ = 0) no hay dato para calcularlo.
 */
function riesgoRotacion({ R, Q, demanda, vmr, tr }) {
  if (!demanda || demanda <= 0 || Q <= 0) return false;
  return R < Q / demanda + (vmr || 0) + (tr || 0);
}

/**
 * RN-03: se acepta un lote si días restantes ≥ cobertura esperada + VMR(c). La cobertura es Q / d̄; sin demanda
 * registrada se usa TR(c). Fecha ya vencida → rechazo. Por debajo del mínimo → requiere autorización.
 * Devuelve { estado: 'OK' | 'AUTORIZAR' | 'RECHAZAR', dias, minimo }.
 */
function evaluarRecepcion({ caducidad, hoy, cajas, demanda, categoria }) {
  const dias = diasEntre(hoy, caducidad);
  if (dias < 0) return { estado: 'RECHAZAR', dias, minimo: 0 };
  const vmr = categoria && categoria.vmr_dias != null ? categoria.vmr_dias : 0;
  const tr = categoria && categoria.tr_dias != null ? categoria.tr_dias : 0;
  const cobertura = demanda > 0 ? cajas / demanda : tr;
  const minimo = Math.ceil(cobertura + vmr);
  return { estado: dias >= minimo ? 'OK' : 'AUTORIZAR', dias, minimo };
}

/** Catálogo de motivos de excepción FEFO (RN-09); clasifica las causas de incumplimiento (C3). */
const MOTIVOS = {
  DATO_CADUCIDAD: 'Dato de caducidad faltante o erróneo',
  MOVIMIENTO_NO_REGISTRADO: 'Movimiento no registrado',
  TARIMA_INACCESIBLE: 'Tarima inaccesible',
  DECISION_OPERADOR: 'Decisión del operador (con justificación)',
  PRODUCTO_DANADO: 'Producto dañado',
  PEDIDO_CLIENTE: 'Lote pedido por el cliente',
};

module.exports = {
  caducidadDe, caducado, compararFefo, asignarFefo, loteFefo,
  umbral, nivelAlerta, riesgoRotacion, evaluarRecepcion, MOTIVOS,
};
