/** Inicio: las tareas del rol como botones grandes, con lo que está pendiente en cada una. */
import { api } from '../api.js';
import { enCola } from '../cola/cola.js';
import { estado, puede } from '../estado.js';
import { h, icono, pintar, ROL } from '../ui.js';

export function vistaInicio() {
  const insignias: Record<string, HTMLElement> = {};
  const m = (href: string, ic: string, titulo: string, detalle: string, clave?: string) => {
    const insignia = h('span', { class: 'mosaico-insignia', hidden: true });
    if (clave) insignias[clave] = insignia;
    return h('a', { class: 'mosaico', href },
      h('span', { class: 'mosaico-icono' }, icono(ic)),
      h('span', { class: 'mosaico-texto' }, titulo, h('small', null, detalle)),
      insignia);
  };
  const cola = h('div');
  const u = estado.usuario;
  const hoy = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  pintar(
    h('div', { class: 'saludo' },
      h('h2', null, `Hola, ${u?.nombre ?? ''}`),
      h('p', { class: 'tenue chico' }, `${ROL[u?.rol ?? ''] ?? u?.rol ?? ''} · ${hoy}`)),
    cola,
    h('div', { class: 'mosaicos' },
      m('#/recibir', 'recibir', 'Recibir tarima', 'Lotes, ID y etiqueta QR'),
      m('#/mover', 'mover', 'Ubicar o mover', 'Escanear tarima y lugar'),
      m('#/surtir', 'surtir', 'Surtir pedido', 'Lista FEFO', 'pedidos'),
      m('#/buscar', 'buscar', 'Buscar', 'Lote, producto o tarima'),
      m('#/mapa', 'mapa', 'Mapa', 'Ocupación y riesgo'),
      puede('supervisor') ? m('#/alertas', 'alertas', 'Alertas', 'Caducidad por categoría', 'alertas') : null,
      puede('supervisor') ? m('#/admin', 'supervision', 'Supervisión', 'Pedidos, umbrales y evaluación') : null));
  void contar(insignias, cola);
}

function mostrar(el: HTMLElement | undefined, texto: string, urgente = false) {
  if (!el) return;
  el.textContent = texto;
  el.classList.toggle('urgente', urgente);
  el.hidden = false;
}

// Cada conteo es independiente: si no hay red, simplemente no aparece
async function contar(insignias: Record<string, HTMLElement>, cola: HTMLElement) {
  enCola().then((movs) => {
    const n = movs.filter((x) => x.estado === 'pendiente').length;
    const rechazados = movs.length - n;
    if (!n && !rechazados) return;
    cola.replaceChildren(h('a', { class: rechazados ? 'pend aviso-enlace' : 'warn aviso-enlace', href: '#/pendientes' },
      icono('nube'),
      h('span', null, n ? `${n} ${n === 1 ? 'movimiento' : 'movimientos'} sin enviar` : '',
        n && rechazados ? ' · ' : '', rechazados ? `${rechazados} con error` : ''),
      h('span', { class: 'aviso-flecha', 'aria-hidden': 'true' }, '›')));
  }).catch(() => {});
  api<Array<{ cancelado: boolean; cajas: number; surtidas: number }>>('GET', '/pedidos').then((ps) => {
    const abiertos = ps.filter((p) => !p.cancelado && p.surtidas < p.cajas).length;
    if (abiertos) mostrar(insignias.pedidos, `${abiertos} ${abiertos === 1 ? 'abierto' : 'abiertos'}`);
  }).catch(() => {});
  if (puede('supervisor')) {
    api<{ conteo: Record<string, number> }>('GET', '/alertas').then((d) => {
      const urgentes = (d.conteo.vencido ?? 0) + (d.conteo.critico ?? 0);
      if (urgentes) mostrar(insignias.alertas, `${urgentes} ${urgentes === 1 ? 'urgente' : 'urgentes'}`, true);
    }).catch(() => {});
  }
}
