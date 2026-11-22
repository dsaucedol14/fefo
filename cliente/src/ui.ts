/** Utilidades de interfaz sin framework. Todo el texto pasa por textContent, nunca por innerHTML (sin inyección). */

type Hijo = Node | string | number | null | undefined | false | Hijo[];
type Atributos = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(etiqueta: K, atrib: Atributos | null = null, ...hijos: Hijo[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(atrib ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  agregar(el, hijos);
  return el;
}

function agregar(el: Node, hijos: Hijo[]) {
  for (const c of hijos) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) agregar(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/**
 * Accesibilidad (WCAG 2.2): toda etiqueta sin «for» se asocia con el control que la sigue, también en lo que se
 * redibuja después (renglones que se agregan). Así los lectores de pantalla y las pruebas encuentran cada campo.
 */
let siguienteId = 0;
function asociarEtiquetas(raiz: ParentNode) {
  raiz.querySelectorAll('label:not([for])').forEach((l) => {
    const control = l.nextElementSibling;
    if (control && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) {
      if (!control.id) control.id = `campo-${++siguienteId}`;
      l.setAttribute('for', control.id);
    }
  });
}
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  new MutationObserver(() => asociarEtiquetas(document.body)).observe(document.documentElement, { childList: true, subtree: true });
}

/** Reemplaza el contenido de main. */
export function pintar(...hijos: Hijo[]) {
  const main = document.querySelector('main')!;
  main.replaceChildren();
  agregar(main, hijos);
  window.scrollTo(0, 0);
}

let temporizador: number | undefined;
export function avisar(texto: string, tipo: 'ok' | 'error' | 'info' = 'ok') {
  document.querySelector('.aviso-flotante')?.remove();
  const el = h('div', { class: `aviso-flotante ${tipo}`, role: tipo === 'error' ? 'alert' : 'status' }, texto);
  document.body.appendChild(el);
  clearTimeout(temporizador);
  temporizador = window.setTimeout(() => el.remove(), tipo === 'error' ? 6000 : 3500);
  vibrar(tipo === 'error' ? [80, 60, 80] : 60);
}

/** Retroalimentación inmediata al aceptar o rechazar (P3 VIII.D). */
export function vibrar(patron: number | number[]) {
  if (navigator.vibrate) navigator.vibrate(patron);
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export function fecha(f: string | null | undefined): string {
  if (!f) return '';
  const [a, m, d] = f.slice(0, 10).split('-').map(Number);
  return `${d} ${MESES[m - 1]} ${a}`;
}
export function hora(f: string | null | undefined): string {
  if (!f) return '';
  const d = new Date(f);
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}
export function dias(d: number): string {
  if (d === 0) return 'caduca hoy';
  if (d > 0) return `${d} ${d === 1 ? 'día' : 'días'}`;
  return `vencido hace ${-d} ${d === -1 ? 'día' : 'días'}`;
}
/** ID de tarima abreviado como en la Fig. 11 (000…1234). */
export const corto = (id: string) => (id.length === 18 ? `${id.slice(0, 3)}…${id.slice(-4)}` : id);

export const NIVEL: Record<string, string> = { vencido: 'Vencido', critico: 'Crítico', alto: 'Alto', preventivo: 'Preventivo', rotacion: 'Riesgo por rotación' };
export const nivel = (n: string | null) => (n ? h('span', { class: `nivel n-${n}` }, NIVEL[n] ?? n) : null);

export const MOTIVOS: Record<string, string> = {
  tarima_inaccesible: 'Tarima inaccesible',
  lote_pedido_cliente: 'Lote pedido por el cliente',
  producto_danado: 'Producto dañado',
  dato_caducidad_erroneo: 'Dato de caducidad erróneo',
  movimiento_no_registrado: 'Movimiento no registrado',
  decision_operador: 'Decisión del operador (justificar)',
};
