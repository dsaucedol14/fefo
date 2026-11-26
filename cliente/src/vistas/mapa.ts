/** Mapa de ocupación por zona: en piso cada columna es una fila del frente (arriba) al fondo (abajo); color = peor alerta. */
import { api } from '../api.js';
import { h, NIVEL, pintar } from '../ui.js';
import { encabezado } from '../main.js';

interface Celda { id_posicion: string; zona: string; tipo: string; es_fria: boolean; fila: string | null; profundidad: number; id_tarima: string | null; nivel: string | null }
const COLOR: Record<string, string> = { vencido: 'var(--vencido)', critico: 'var(--critico)', alto: '#e07b00', preventivo: '#e8c200' };

export async function vistaMapa() {
  encabezado('Mapa del almacén');
  const celdas = await api<Celda[]>('GET', '/mapa');
  const zonas = new Map<string, Map<string, Celda[]>>();
  for (const c of celdas) {
    const grupo = c.fila ?? c.id_posicion.split('-').slice(0, -1).join('-');
    if (!zonas.has(c.zona)) zonas.set(c.zona, new Map());
    const z = zonas.get(c.zona)!;
    if (!z.has(grupo)) z.set(grupo, []);
    z.get(grupo)!.push(c);
  }
  const celda = (c: Celda) => c.id_tarima
    ? h('a', { class: `celda ocupada${c.nivel ? ` n-${c.nivel}` : ''}`, href: `#/tarima/${c.id_tarima}`, title: `${c.id_posicion}${c.nivel ? ` · ${c.nivel}` : ''}`,
      style: c.nivel ? `background:${COLOR[c.nivel]}` : '' })
    : h('span', { class: 'celda', title: `${c.id_posicion} · libre` });
  const muestra = (texto: string, clase: string, color?: string) => h('span', { class: 'leyenda-item' },
    h('span', { class: `celda ${clase}`, style: color ? `background:${color}` : '' }), texto);
  pintar(
    h('div', { class: 'card' },
      h('div', { class: 'leyenda' },
        muestra('Libre', ''), muestra('Ocupada', 'ocupada'),
        ...Object.entries(COLOR).map(([n, c]) => muestra(NIVEL[n] ?? n, `ocupada n-${n}`, c))),
      h('p', { class: 'chico tenue', style: 'margin:8px 0 0' }, 'El color de una tarima es el peor nivel de alerta de sus lotes. Toca una para ver su detalle.')),
    [...zonas].map(([zona, grupos]) => {
      const todas = [...grupos.values()].flat();
      const t = todas[0];
      return h('div', { class: 'card' },
        h('h3', null, `Zona ${zona} · ${t.tipo === 'piso' ? 'piso en filas' : t.tipo === 'camara' ? 'cámara fría' : 'rack'} · ${todas.filter((c) => c.id_tarima).length} de ${todas.length}`),
        h('div', { class: 'zona' }, [...grupos].map(([g, cs]) => h('div', { class: 'grupo' }, h('span', null, g.split('-').slice(1).join('-')),
          cs.sort((a, b) => (a.fila ? a.profundidad - b.profundidad : b.id_posicion.localeCompare(a.id_posicion))).map(celda)))));
    }));
}
