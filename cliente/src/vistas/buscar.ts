/** CU-04 Localizar lote o tarima (RF-07, RF-09): por código, nombre o escaneo; zona, fila, profundidad y bloqueo. */
import { api, urlApi } from '../api.js';
import { puede, tarea } from '../estado.js';
import { clasificar } from '../escaner/gs1.js';
import { campoEscaneo } from '../escaner/lector.js';
import { avisar, corto, dias, fecha, h, pintar } from '../ui.js';
import { encabezado } from '../main.js';

interface Fila { id_lote: string; num_lote: string; sku: string; producto: string; caducidad_vigente: string; id_tarima: string; id_posicion: string | null;
  zona: string | null; profundidad: number | null; cajas: number; tarimas_delante: number; bloqueada_por: string | null; es_candidato_fefo: boolean; dias_restantes: number }

export function vistaBuscar(p: URLSearchParams) {
  encabezado('Buscar');
  const contador = { n: 0 };
  const resultados = h('div');
  async function buscar(v: string) {
    const l = clasificar(v);
    const q = new URLSearchParams();
    if (l.tipo === 'gs1') { q.set('gtin', l.valor.gtin); if (l.valor.lote) q.set('lote', l.valor.lote); } else q.set('q', String(l.valor));
    const t = tarea.actual();
    if (t) q.set('tarea', t);
    q.set('escaneos', String(contador.n));
    const r = await api<{ tipo: string; id_tarima?: string; resultados: Fila[] }>('GET', `/buscar?${q}`).catch((e) => { avisar(e.message, 'error'); return null; });
    if (!r) return;
    if (r.tipo === 'tarima') { location.hash = `#/tarima/${r.id_tarima}`; return; }
    resultados.replaceChildren(r.resultados.length ? h('p', { class: 'tenue chico' }, `${r.resultados.length} resultados. `, h('span', { class: 'fefo' }, 'FEFO'), ' sale primero.') : h('div', { class: 'card tenue' }, 'Sin existencias que coincidan.'),
      ...r.resultados.map((x) => h('a', { class: `card${x.es_candidato_fefo ? ' propuesta' : ''}`, href: `#/tarima/${x.id_tarima}`, style: 'display:block;text-decoration:none;color:inherit' },
        h('h3', null, x.producto, ' ', x.es_candidato_fefo ? h('span', { class: 'fefo' }, 'FEFO') : null),
        h('div', { class: 'chico tenue' }, `Lote ${x.num_lote} · caduca ${fecha(x.caducidad_vigente)} (${dias(x.dias_restantes)}) · ${x.cajas} cajas`),
        h('div', { class: 'big' }, x.id_posicion ?? 'Por ubicar'),
        h('div', { class: 'chico' }, `Zona ${x.zona ?? '—'}${x.profundidad && x.profundidad > 1 ? ` · profundidad ${x.profundidad}` : ''} · tarima ${corto(x.id_tarima)}`),
        x.tarimas_delante ? h('div', { class: 'warn' }, `Bloqueado por ${x.tarimas_delante}: ${(x.bloqueada_por ?? '').split(',').map(corto).join(', ')}`) : null)));
  }
  const campo = campoEscaneo({ etiqueta: 'Lote, producto, tarima o posición', contador, enfocar: true, valor: p.get('q') ?? '', alLeer: (v) => void buscar(v) });
  pintar(h('div', { class: 'card' }, campo.el, h('button', { class: 'btn', type: 'button', onclick: () => { contador.n = Math.max(0, contador.n); void buscar(campo.entrada.value); } }, 'Buscar')), resultados);
  if (p.get('q')) void buscar(p.get('q')!);
}

export async function vistaTarima(id: string) {
  const t = await api<{ id_tarima: string; id_posicion: string | null; estado: string; zona: string | null; profundidad: number | null; tarimas_delante: number; bloqueada_por: string[];
    lotes: Array<{ id_lote: string; producto: string; num_lote: string; cajas: number; caducidad_vigente: string; caducidad_efectiva: string | null }>;
    movimientos: Array<{ tipo: string; delta_cajas: number; pos_origen: string | null; pos_destino: string | null; es_fefo: boolean | null; motivo_excepcion: string | null; num_lote: string | null; id_usuario: string; fecha_dispositivo: string }> }>('GET', `/tarimas/${id}`);
  encabezado(`Tarima ${corto(t.id_tarima)}`, t.estado === 'vacia' ? 'Vacía: ya salió' : t.estado === 'por_ubicar' ? 'Por ubicar' : '');
  const hoy = new Date().toLocaleDateString('sv'); // AAAA-MM-DD local
  pintar(
    h('div', { class: 'card' },
      h('div', { class: 'lbl' }, 'Ubicación'), h('div', { class: 'big' }, t.id_posicion ?? (t.estado === 'vacia' ? '—' : 'Por ubicar')),
      t.zona ? h('div', { class: 'chico' }, `Zona ${t.zona}${t.profundidad && t.profundidad > 1 ? ` · profundidad ${t.profundidad}` : ''}`) : null,
      t.tarimas_delante ? h('div', { class: 'warn' }, `Bloqueada por ${t.tarimas_delante}: ${t.bloqueada_por.map(corto).join(', ')}`) : null,
      h('div', { class: 'chico tenue mono', style: 'margin-top:6px' }, t.id_tarima)),
    h('div', { class: 'card' }, h('h3', null, 'Lotes'), t.lotes.length ? t.lotes.map((l) => h('div', { class: 'fila-dato' },
      h('span', null, `${l.producto} · ${l.num_lote}`, h('br'), h('span', { class: 'chico tenue' }, `Caduca ${fecha(l.caducidad_vigente)}${l.caducidad_efectiva ? ' (efectiva)' : ''}`)),
      h('b', null, `${l.cajas}`),
      l.caducidad_vigente < hoy ? h('button', { class: 'opt', style: 'width:auto;margin:0', type: 'button', onclick: async () => {
        try { await api('POST', '/bajas', { id_lote: l.id_lote, id_tarima: t.id_tarima, motivo: 'caducidad' }); avisar('Baja propuesta.'); } catch (e) { avisar((e as Error).message, 'error'); }
      } }, 'Proponer baja') : null)) : h('p', { class: 'tenue' }, 'Sin existencias.')),
    t.estado !== 'vacia' ? h('div', { class: 'btn-linea' },
      h('a', { class: 'btn sec', href: urlApi(`/etiquetas/tarimas/${t.id_tarima}`), target: '_blank', rel: 'noopener' }, 'Etiqueta'),
      h('a', { class: 'btn', href: `#/mover?tarima=${t.id_tarima}` }, t.id_posicion ? 'Mover' : 'Ubicar')) : null,
    puede('almacenista') ? h('div', { class: 'card desplazable', style: 'margin-top:14px' }, h('h3', null, 'Movimientos'),
      h('table', { class: 'tabla' }, h('tr', null, h('th', null, 'Hora'), h('th', null, 'Tipo'), h('th', null, 'Detalle')),
        t.movimientos.map((m) => h('tr', null, h('td', null, `${fecha(m.fecha_dispositivo)} ${new Date(m.fecha_dispositivo).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`),
          h('td', null, m.tipo), h('td', null, [m.num_lote, m.delta_cajas ? `${m.delta_cajas} cajas` : '', m.pos_origen || m.pos_destino ? `${m.pos_origen ?? ''} → ${m.pos_destino ?? ''}` : '',
            m.es_fefo === false ? `no FEFO (${m.motivo_excepcion})` : m.es_fefo ? 'FEFO' : '', m.id_usuario].filter(Boolean).join(' · ')))))) : null);
}
