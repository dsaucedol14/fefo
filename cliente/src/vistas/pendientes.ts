/** Cola visible (Fig. 11c): movimientos sin enviar y los que la base rechazó al sincronizar. */
import { descartar, enCola, sincronizar } from '../cola/cola.js';
import { estado } from '../estado.js';
import { avisar, corto, h, hora, pintar } from '../ui.js';
import { encabezado } from '../main.js';

const TIPO: Record<string, string> = { ubicacion: 'Ubicación', reubicacion: 'Reubicación', salida: 'Salida' };

export async function vistaPendientes() {
  encabezado('Movimientos en el teléfono', estado.enLinea ? 'En línea' : 'Sin red');
  const cola = await enCola();
  const pendientes = cola.filter((x) => x.estado === 'pendiente');
  const rechazados = cola.filter((x) => x.estado === 'rechazado');
  const fila = (x: (typeof cola)[number]) => h('div', { class: 'fila-dato' },
    h('span', null, `${TIPO[x.mov.tipo]} T…${x.mov.id_tarima.slice(-4)}`, x.mov.pos_destino ? ` → ${x.mov.pos_destino}` : '', x.mov.cajas ? ` · ${x.mov.cajas} cajas` : '',
      x.mensaje ? h('div', { class: 'chico', style: 'color:var(--error)' }, x.mensaje) : null),
    h('span', null, hora(x.mov.fecha_dispositivo)));
  pintar(
    pendientes.length ? h('div', { class: 'pend' }, h('b', null, pendientes.length === 1 ? '1 movimiento pendiente' : `${pendientes.length} movimientos pendientes`), ' se enviarán al recuperar la señal. No cierre la sesión.') : h('div', { class: 'ok-msg' }, 'No hay movimientos pendientes.'),
    pendientes.length ? h('div', { class: 'card' }, h('div', { class: 'lbl' }, 'Pendientes'), pendientes.map(fila)) : null,
    rechazados.length ? h('div', { class: 'card' }, h('div', { class: 'lbl' }, 'Rechazados por la base (el supervisor también los ve)'),
      rechazados.map((x) => h('div', null, fila(x), h('button', { class: 'btn sec', type: 'button', style: 'margin-top:6px', onclick: async () => { await descartar(x.id_mov); void vistaPendientes(); } },
        `Quitar del teléfono (${corto(x.mov.id_tarima)})`)))) : null,
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      await sincronizar();
      avisar(navigator.onLine ? 'Sincronización terminada.' : 'Sigue sin red.', navigator.onLine ? 'ok' : 'error');
      void vistaPendientes();
    } }, 'Enviar ahora'));
}
