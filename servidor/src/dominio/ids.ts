/**
 * ID de tarima de 18 dígitos con dígito verificador GS1 (ADR-007): misma estructura que un SSCC
 * (extensión + prefijo de empresa + serie + verificador), para migrar a SSCC sin cambiar el modelo.
 */

/** Dígito verificador GS1 (módulo 10) de una cadena de dígitos sin el verificador. */
export function digitoVerificador(digitos: string): number {
  let suma = 0;
  for (let i = 0; i < digitos.length; i++) {
    suma += Number(digitos[digitos.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (suma % 10)) % 10;
}

/** 0 + prefijo (7) + serie (9) + verificador (1) = 18 dígitos. */
export function idTarima(prefijo: number | string, serie: number): string {
  const base = `0${String(prefijo).padStart(7, '0').slice(-7)}${String(serie).padStart(9, '0')}`;
  return base + digitoVerificador(base);
}

export function idTarimaValido(id: string): boolean {
  return /^\d{18}$/.test(id) && digitoVerificador(id.slice(0, 17)) === Number(id[17]);
}
