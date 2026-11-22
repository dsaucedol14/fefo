/**
 * Identificador de tarima de 18 dígitos con dígito verificador GS1 (CF4 de P2): tiene la misma estructura que un
 * SSCC (extensión + prefijo de empresa + serie + verificador), así migrar a SSCC real no cambia el modelo de datos.
 */

/** Dígito verificador GS1 (módulo 10) de una cadena de dígitos sin el verificador. */
function digitoVerificador(digitos) {
  let suma = 0;
  const s = String(digitos);
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[s.length - 1 - i]);
    suma += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (suma % 10)) % 10;
}

/** 0 + prefijo (7) + serie (9) + verificador (1) = 18 dígitos. */
function idTarima(prefijo, serie) {
  const base = `0${String(prefijo).padStart(7, '0').slice(-7)}${String(serie).padStart(9, '0')}`;
  return base + digitoVerificador(base);
}

/** ¿Es un ID de 18 dígitos con verificador correcto? */
function idTarimaValido(id) {
  return /^\d{18}$/.test(id) && digitoVerificador(id.slice(0, 17)) === Number(id[17]);
}

module.exports = { digitoVerificador, idTarima, idTarimaValido };
