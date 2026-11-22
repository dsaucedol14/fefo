/**
 * Lectura de códigos GS1 de las cajas (GS1-128, DataMatrix o QR con identificadores de aplicación):
 * (01) GTIN, (10) lote, (17) caducidad y (15) consumo preferente. Sirve en el servidor y en el navegador.
 * Acepta la forma legible «(01)07501234567890(17)261128(10)L2611A» y la cruda con separador GS (\x1d).
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.GS1 = fabrica();
}(typeof self !== 'undefined' ? self : this, () => {
  const FIJOS = { '00': 18, '01': 14, '02': 14, 11: 6, 12: 6, 13: 6, 15: 6, 16: 6, 17: 6, 20: 2 };
  const VARIABLES = { 10: 20, 21: 20, 22: 20, 30: 8, 37: 8 };

  /** AAMMDD → AAAA-MM-DD. Día 00 = último día del mes (regla GS1). */
  function fechaGs1(aammdd) {
    if (!/^\d{6}$/.test(aammdd)) return null;
    const anio = 2000 + Number(aammdd.slice(0, 2));
    const mes = Number(aammdd.slice(2, 4));
    let dia = Number(aammdd.slice(4, 6));
    if (mes < 1 || mes > 12) return null;
    const ultimo = new Date(anio, mes, 0).getDate();
    if (dia === 0) dia = ultimo;
    if (dia > ultimo) return null;
    return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  }

  function leerLegible(texto) {
    const ais = {};
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m;
    while ((m = re.exec(texto))) ais[m[1]] = m[2].trim();
    return ais;
  }

  function leerCrudo(texto) {
    const ais = {};
    let i = 0;
    while (i < texto.length) {
      if (texto[i] === '\x1d') { i++; continue; }
      const ai = texto.slice(i, i + 2);
      if (FIJOS[ai] !== undefined) {
        ais[ai] = texto.slice(i + 2, i + 2 + FIJOS[ai]);
        i += 2 + FIJOS[ai];
      } else if (VARIABLES[ai] !== undefined) {
        const resto = texto.slice(i + 2);
        const fin = resto.indexOf('\x1d');
        const valor = (fin === -1 ? resto : resto.slice(0, fin)).slice(0, VARIABLES[ai]);
        ais[ai] = valor;
        i += 2 + valor.length;
      } else {
        break; // identificador no soportado: lo que sigue no se interpreta
      }
    }
    return ais;
  }

  /**
   * Devuelve { gtin, lote, caducidad, consumoPreferente } o null si el texto no es un código GS1 con GTIN.
   * La fecha de caducidad (17) tiene prioridad; si solo trae (15), se usa como fecha de referencia.
   */
  function leer(entrada) {
    if (!entrada) return null;
    let texto = String(entrada).trim().replace(/^\](C1|e0|d2|Q3)/, '');
    const ais = texto.includes('(') ? leerLegible(texto) : leerCrudo(texto);
    if (!ais['01'] || !/^\d{14}$/.test(ais['01'])) return null;
    const caducidad = ais['17'] ? fechaGs1(ais['17']) : null;
    const consumoPreferente = ais['15'] ? fechaGs1(ais['15']) : null;
    return {
      gtin: ais['01'],
      lote: ais['10'] || null,
      caducidad: caducidad || consumoPreferente,
      fuenteFecha: caducidad ? '17' : consumoPreferente ? '15' : null,
    };
  }

  /** Claves de producto que puede tener un GTIN-14 en el catálogo: el GTIN-14 y el EAN-13 sin el cero inicial. */
  function clavesProducto(gtin) {
    return gtin.startsWith('0') ? [gtin, gtin.slice(1)] : [gtin];
  }

  return { leer, fechaGs1, clavesProducto };
}));
