/** CU-07 Consultar alertas (RF-14, RN-07; RF-16): lotes por nivel de U(c) y riesgo por rotación, con su ubicación y bloqueo. */
import { api } from '../api.js';
import { avisar, corto, dias, fecha, h, nivel, NIVEL, pintar } from '../ui.js';
import { encabezado } from '../main.js';

interface Alerta { id_lote: string; producto: string; categoria: string; num_lote: string; caducidad_vigente: string; dias_restantes: number; umbral_dias: number;
  cajas: number; nivel: string | null; riesgo_rotacion: boolean; tarimas: Array<{ id_tarima: string; cajas: number; id_posicion: string | null; tarimas_delante: number; bloqueada_por: string | null }> }

export async function vistaAlertas(p: URLSearchParams) {
  encabezado('Alertas de caducidad');
  const d = await api<{ conteo: Record<string, number>; alertas: Alerta[]; bajas: Array<{ num_lote: string; producto: string; cajas: number; id_tarima: string; registrado_por: string }> }>('GET', '/alertas');
  const filtro = p.get('nivel');
  const lista = d.alertas.filter((a) => !filtro || (filtro === 'rotacion' ? a.riesgo_rotacion : filtro === 'bloqueados'
    ? a.nivel && a.nivel !== 'vencido' && a.tarimas.some((t) => t.tarimas_delante > 0) : a.nivel === filtro));
  const cifra = (clave: string, texto: string) => h('a', { class: `cifra${filtro === clave ? ' sel' : ''}`, href: filtro === clave ? '#/alertas' : `#/alertas?nivel=${clave}` },
    h('span', { class: 'chico' }, texto), h('b', null, d.conteo[clave] ?? 0));
  pintar(
    h('div', { class: 'cifras', style: 'margin-bottom:14px' },
      cifra('vencido', 'Vencido'), cifra('critico', 'Crítico'), cifra('alto', 'Alto'), cifra('preventivo', 'Preventivo'), cifra('rotacion', 'Rotación'), cifra('bloqueados', 'Bloqueados')),
    d.bajas.length ? h('div', { class: 'card' }, h('h3', null, 'Bajas propuestas pendientes'), h('p', { class: 'chico tenue' }, 'La autorización por otro supervisor (RF-17) se construye en la productización.'),
      d.bajas.map((b) => h('div', { class: 'fila-dato chico' }, h('span', null, `${b.producto} · ${b.num_lote} · ${corto(b.id_tarima)}`), h('span', null, `${b.cajas} cajas · ${b.registrado_por}`)))) : null,
    lista.length ? null : h('div', { class: 'ok-msg' }, 'No hay lotes en este nivel.'),
    lista.map((a) => h('div', { class: 'card' },
      h('h3', null, nivel(a.nivel), ' ', a.riesgo_rotacion ? h('span', { class: 'nivel n-rotacion' }, NIVEL.rotacion) : null, ' ', a.producto),
      h('div', { class: 'chico' }, `Lote ${a.num_lote} · caduca ${fecha(a.caducidad_vigente)} · `, h('b', null, dias(a.dias_restantes)), ` · ${a.cajas} cajas`),
      h('div', { class: 'chico tenue' }, `${a.categoria}: U(c) = ${a.umbral_dias} días`),
      a.tarimas.map((t) => h('div', { class: 'fila-dato chico' },
        h('a', { href: `#/tarima/${t.id_tarima}` }, `${t.id_posicion ?? 'por ubicar'} · ${corto(t.id_tarima)} · ${t.cajas} cajas`),
        t.tarimas_delante ? h('span', { style: 'color:var(--aviso);font-weight:700' }, `bloqueada por ${t.tarimas_delante}`) : null,
        a.nivel === 'vencido' ? h('button', { class: 'opt', style: 'width:auto;margin:0;min-height:44px', type: 'button', onclick: async () => {
          try { await api('POST', '/bajas', { id_lote: a.id_lote, id_tarima: t.id_tarima, motivo: 'caducidad' }); avisar('Baja propuesta.'); void vistaAlertas(p); }
          catch (e) { avisar((e as Error).message, 'error'); }
        } }, 'Proponer baja') : null)))));
}
