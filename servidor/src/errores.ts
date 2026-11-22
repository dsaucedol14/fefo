/**
 * Traducción de los errores de la base a códigos y mensajes del almacén (consecuencia de ADR-003):
 * la base rechaza; la API explica la causa en lenguaje del almacén (P3 VIII.D, «Retroalimentación inmediata»).
 */

export class ErrorNegocio extends Error {
  constructor(public codigo: string, mensaje: string, public estado = 400, public extra: Record<string, unknown> = {}) {
    super(mensaje);
  }
}

interface ErrorPg { code?: string; message?: string; constraint?: string; detail?: string }

const MAPA: Array<[RegExp, string, string]> = [
  [/^RN-02/, 'caducado', 'Ese lote ya caducó: no puede salir. Propón su baja.'],
  [/^RN-09/, 'requiere_motivo', 'El lote no es el FEFO: elige el motivo de la excepción.'],
  [/^RN-05: la tarima .* mezcla/, 'rn05_mezcla', 'Una tarima no puede mezclar productos refrigerados y de ambiente.'],
  [/^RN-05: la zona C/, 'rn05_camara', 'La cámara fría está reservada a refrigerados.'],
  [/^RN-05/, 'rn05_frio', 'La tarima trae refrigerados: solo puede ir a la cámara fría.'],
  [/^Origen desactualizado/, 'origen_desactualizado', 'La tarima ya no está donde dice el teléfono; alguien la movió. Vuelve a escanearla.'],
  [/no está en la tarima/, 'lote_no_en_tarima', 'Ese lote no está en la tarima escaneada.'],
  [/no está disponible/, 'lote_no_disponible', 'Ese lote está retenido o dado de baja.'],
  [/^RF-20/, 'solo_insercion', 'La historia no se puede modificar.'],
];

export function traducir(e: unknown): ErrorNegocio | null {
  if (e instanceof ErrorNegocio) return e;
  const err = e as ErrorPg;
  const msg = err?.message ?? '';
  if (err?.code === 'P0001') {
    for (const [re, codigo, texto] of MAPA) if (re.test(msg)) return new ErrorNegocio(codigo, texto, 409, { detalle: msg });
    return new ErrorNegocio('regla', msg, 409);
  }
  if (err?.code === '23505' && err.constraint === 'ux_tarima_posicion') {
    return new ErrorNegocio('posicion_ocupada', 'Esa posición ya tiene tarima.', 409);
  }
  if (err?.code === '23514') {
    if (/tarima_lote_cajas_check/.test(msg)) return new ErrorNegocio('saldo_insuficiente', 'La tarima no tiene tantas cajas de ese lote.', 409);
    if (/lote_check/.test(msg)) return new ErrorNegocio('caducidad_invalida', 'La caducidad es anterior a la fecha de recepción.', 400);
    if (/movimiento_check/.test(msg)) return new ErrorNegocio('movimiento_invalido', 'El movimiento no es coherente con su tipo.', 400);
    if (/posicion_check/.test(msg)) return new ErrorNegocio('posicion_invalida', 'La clave de la posición no tiene un formato válido (RN-04).', 400);
    if (/tarima_check/.test(msg)) return new ErrorNegocio('estado_tarima', 'El estado de la tarima no es coherente con su posición.', 409);
    return new ErrorNegocio('restriccion', msg, 400);
  }
  if (err?.code === '23503') {
    if (/pos_destino|pos_origen|id_posicion/.test(err.detail ?? msg)) return new ErrorNegocio('posicion_inexistente', 'Esa posición no existe. Revisa la etiqueta.', 404);
    if (/id_tarima/.test(err.detail ?? msg)) return new ErrorNegocio('tarima_inexistente', 'Esa tarima no existe. Revisa la etiqueta.', 404);
    if (/id_lote/.test(err.detail ?? msg)) return new ErrorNegocio('lote_inexistente', 'Ese lote no existe.', 404);
    return new ErrorNegocio('referencia', 'Un dato referido no existe.', 400);
  }
  if (err?.code === '22P02') return new ErrorNegocio('formato', 'Un identificador no tiene el formato correcto.', 400);
  return null;
}
