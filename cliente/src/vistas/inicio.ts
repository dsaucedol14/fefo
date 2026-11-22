/** Inicio: las tareas del rol como botones grandes. */
import { estado, puede } from '../estado.js';
import { h, pintar } from '../ui.js';

export function vistaInicio() {
  const m = (href: string, titulo: string, detalle: string) => h('a', { class: 'mosaico', href }, titulo, h('small', null, detalle));
  pintar(
    h('div', { class: 'mosaicos' },
      m('#/recibir', 'Recibir tarima', 'Lotes, ID y etiqueta QR'),
      m('#/mover', 'Ubicar o mover', 'Escanear tarima y lugar'),
      m('#/surtir', 'Surtir pedido', 'Lista FEFO'),
      m('#/buscar', 'Buscar', 'Lote, producto o tarima'),
      m('#/mapa', 'Mapa', 'Ocupación y riesgo'),
      puede('supervisor') ? m('#/alertas', 'Alertas', 'Caducidad por categoría') : null,
      puede('supervisor') ? m('#/admin', 'Supervisión', 'Pedidos, umbrales y evaluación') : null),
    h('p', { class: 'tenue chico', style: 'margin-top:16px' }, `${estado.usuario?.nombre} · ${estado.usuario?.rol}`));
}
