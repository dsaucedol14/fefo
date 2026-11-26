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

// Íconos de trazo (24 × 24); cada trazo separado por «|». Decorativos: el texto de al lado da el nombre.
const ICONOS: Record<string, string> = {
  inicio: 'M3 10.5 12 3l9 7.5|M5 9.5V21h14V9.5|M10 21v-6h4v6',
  recibir: 'M4 8l8-4 8 4-8 4z|M4 8v8l8 4 8-4V8|M12 12v8',
  mover: 'M4 9h15|M15 5l4 4-4 4|M20 15H5|M9 11l-4 4 4 4',
  surtir: 'M9 3h6v3H9z|M8 4.5H6a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2|M8 13l2.5 2.5L16 10',
  buscar: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z|M20 20l-4-4',
  mapa: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
  alertas: 'M12 3.5 21.5 20h-19z|M12 10v4.5|M12 17.2v.3',
  supervision: 'M4 7h9|M17 7h3|M15 5v4|M4 12h3|M11 12h9|M9 10v4|M4 17h11|M19 17h1|M17 15v4',
  camara: 'M4 8h3.5l2-3h5l2 3H20v11H4z|M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  nube: 'M7 18.5a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 11.5a3.5 3.5 0 0 1-.5 7z|M12 11v6|M9.5 13.5 12 11l2.5 2.5',
  tarima: 'M4.5 5h6.5v7H4.5z|M13 5h6.5v7H13z|M3 14.5h18|M3 19h18|M5 14.5V19|M12 14.5V19|M19 14.5V19',
  check: 'M5 12.5l4.5 4.5L19 7.5',
};
export function icono(nombre: string, clase = 'icono'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', clase);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of (ICONOS[nombre] ?? '').split('|')) {
    const trazo = document.createElementNS(ns, 'path');
    trazo.setAttribute('d', d);
    svg.appendChild(trazo);
  }
  return svg;
}

export const ROL: Record<string, string> = { almacenista: 'Almacenista', supervisor: 'Supervisor', administracion: 'Administración' };

// Indicador de carga: solo aparece si la vista tarda (evita parpadeos en las que responden al instante)
let temporizadorCarga: number | undefined;
export function cargando() {
  clearTimeout(temporizadorCarga);
  temporizadorCarga = window.setTimeout(() => {
    document.querySelector('main')!.replaceChildren(h('div', { class: 'cargando', role: 'status' }, h('span', { class: 'giro', 'aria-hidden': 'true' }), 'Cargando…'));
  }, 200);
}

/** Reemplaza el contenido de main. */
export function pintar(...hijos: Hijo[]) {
  clearTimeout(temporizadorCarga);
  const main = document.querySelector('main')!;
  main.replaceChildren();
  agregar(main, hijos);
  window.scrollTo(0, 0);
}

let temporizador: number | undefined;
export function avisar(texto: string, tipo: 'ok' | 'error' | 'info' = 'ok') {
  document.querySelector('.aviso-flotante')?.remove();
  const el = h('div', { class: `aviso-flotante ${tipo}`, role: tipo === 'error' ? 'alert' : 'status', title: 'Toca para cerrar' }, texto);
  el.addEventListener('click', () => el.remove());
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
