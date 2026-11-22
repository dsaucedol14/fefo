/** Utilidades de fechas, formato y lectura de formularios. Las fechas llegan de MySQL como texto. */
const config = require('./config');

const dos = (n) => String(n).padStart(2, '0');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function iso(d) {
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

/** Fecha de operación 'AAAA-MM-DD': la del .env (FECHA_OPERACION) o la real del equipo. */
function hoy() {
  return /^\d{4}-\d{2}-\d{2}$/.test(config.fechaOperacion) ? config.fechaOperacion : iso(new Date());
}

/** Interpreta 'AAAA-MM-DD[ hh:mm[:ss]]' como fecha local. */
function aFecha(texto) {
  if (!texto) return null;
  if (texto instanceof Date) return texto;
  const m = String(texto).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/** Días naturales de a a b (b − a), solo con la parte de fecha. */
function diasEntre(a, b) {
  const da = aFecha(String(a).slice(0, 10));
  const db = aFecha(String(b).slice(0, 10));
  if (!da || !db) return null;
  return Math.round((Date.UTC(db.getFullYear(), db.getMonth(), db.getDate())
    - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400000);
}

function sumarDias(fecha, n) {
  const d = aFecha(String(fecha).slice(0, 10));
  d.setDate(d.getDate() + n);
  return iso(d);
}

/** 28 nov 2026 */
function fecha(texto) {
  const d = aFecha(texto);
  return d ? `${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()}` : '';
}

/** 28 nov 2026 08:42 */
function fechaHora(texto) {
  const d = aFecha(texto);
  return d ? `${fecha(texto)} ${dos(d.getHours())}:${dos(d.getMinutes())}` : '';
}

/** ¿Es una fecha real con formato AAAA-MM-DD? */
function fechaValida(texto) {
  const m = String(texto || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

/** Texto limpio o null. */
function texto(v, max) {
  if (v === undefined || v === null) return null;
  const t = String(Array.isArray(v) ? v[0] : v).trim();
  if (!t) return null;
  return max ? t.slice(0, max) : t;
}

/** Entero o null. */
function entero(v) {
  const t = texto(v);
  if (t === null || !/^-?\d+$/.test(t)) return null;
  return Number(t);
}

/** Número decimal o null. */
function numero(v) {
  const t = texto(v);
  if (t === null) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Un campo de formulario repetido llega como texto o como arreglo: siempre arreglo. */
function lista(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function miles(n) {
  return Number(n || 0).toLocaleString('es-MX');
}

function pesos(n) {
  return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
}

const NIVELES = { VENCIDO: 'Vencido', CRITICO: 'Crítico', ALTO: 'Alto', PREVENTIVO: 'Preventivo', ROTACION: 'Riesgo por rotación', BLOQUEADO: 'Bloqueados' };
const TIPOS = { ENTRADA: 'Entrada', COLOCACION: 'Colocación', REUBICACION: 'Reubicación', SALIDA: 'Salida', BAJA: 'Baja', AJUSTE: 'Ajuste' };

const nivel = (n) => NIVELES[n] || n;
const tipoMov = (t) => TIPOS[t] || t;

/** «hoy», «en 3 días», «hace 2 días» */
function dias(d) {
  if (d === 0) return 'caduca hoy';
  if (d > 0) return `${d} ${d === 1 ? 'día' : 'días'}`;
  return `vencido hace ${-d} ${d === -1 ? 'día' : 'días'}`;
}

module.exports = { nivel, tipoMov, dias, NIVELES, hoy, aFecha, diasEntre, sumarDias, fecha, fechaHora, fechaValida, texto, entero, numero, lista, miles, pesos, iso };
