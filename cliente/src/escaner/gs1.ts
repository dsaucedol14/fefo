/**
 * Lector de códigos GS1 de las cajas (RF-03, ADR-007): GS1-128, DataMatrix o QR con identificadores de aplicación
 * (01) GTIN, (10) lote, (17) caducidad y (15) consumo preferente. Acepta la forma legible
 * «(01)07501234567890(17)261128(10)L2611A» y la cruda con separador GS (\x1d) y prefijo de simbología.
 */
const FIJOS: Record<string, number> = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
const VARIABLES: Record<string, number> = { '10': 20, '21': 20, '22': 20, '30': 8, '37': 8 };

export interface CodigoGs1 { gtin: string; lote: string | null; caducidad: string | null; fuenteFecha: '17' | '15' | null }

/** AAMMDD → AAAA-MM-DD; el día 00 es el último día del mes (regla GS1). */
export function fechaGs1(aammdd: string): string | null {
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

function leerCrudo(t: string): Record<string, string> {
  const ais: Record<string, string> = {};
  let i = 0;
  while (i < t.length) {
    if (t[i] === '\x1d') { i++; continue; }
    const ai = t.slice(i, i + 2);
    if (FIJOS[ai] !== undefined) {
      ais[ai] = t.slice(i + 2, i + 2 + FIJOS[ai]);
      i += 2 + FIJOS[ai];
    } else if (VARIABLES[ai] !== undefined) {
      const resto = t.slice(i + 2);
      const fin = resto.indexOf('\x1d');
      const valor = (fin === -1 ? resto : resto.slice(0, fin)).slice(0, VARIABLES[ai]);
      ais[ai] = valor;
      i += 2 + valor.length;
    } else break;
  }
  return ais;
}

export function leerGs1(entrada: string): CodigoGs1 | null {
  const t = String(entrada ?? '').trim().replace(/^\](C1|e0|d2|Q3)/, '');
  let ais: Record<string, string>;
  if (t.includes('(')) {
    ais = {};
    for (const m of t.matchAll(/\((\d{2,4})\)([^(]*)/g)) ais[m[1]] = m[2].trim();
  } else ais = leerCrudo(t);
  if (!ais['01'] || !/^\d{14}$/.test(ais['01'])) return null;
  const cad = ais['17'] ? fechaGs1(ais['17']) : null;
  const pref = ais['15'] ? fechaGs1(ais['15']) : null;
  return { gtin: ais['01'], lote: ais['10'] ? ais['10'].toUpperCase() : null, caducidad: cad ?? pref, fuenteFecha: cad ? '17' : pref ? '15' : null };
}

/** Qué se escaneó: ID de tarima (18 dígitos), posición (RN-04), caja GS1 o texto libre. */
export type Lectura = { tipo: 'tarima'; valor: string } | { tipo: 'posicion'; valor: string } | { tipo: 'gs1'; valor: CodigoGs1 } | { tipo: 'texto'; valor: string };

export function clasificar(codigo: string): Lectura {
  const t = codigo.trim();
  const compacto = t.replace(/\s+/g, '').toUpperCase();
  if (/^\d{18}$/.test(compacto)) return { tipo: 'tarima', valor: compacto };
  if (/^[A-Z]-P\d{2}-R\d{2}-N\d$|^[A-Z]-F\d{2}-D[1-4]$|^[A-Z]-R\d{2}-N\d$/.test(compacto)) return { tipo: 'posicion', valor: compacto };
  const g = leerGs1(t);
  if (g) return { tipo: 'gs1', valor: g };
  return { tipo: 'texto', valor: t };
}
