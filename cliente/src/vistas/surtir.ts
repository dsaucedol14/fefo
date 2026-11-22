/**
 * CU-05 Surtir con FEFO y CU-06 Registrar excepción (RF-11, RF-12, RF-13, RF-16, C1; Fig. 7 y 11 de P3).
 * La lista trae por renglón el lote FEFO reservado, su posición, el bloqueo y la alternativa accesible. El operador
 * escanea la tarima de la que saca: si no es el lote propuesto, elige el motivo (RN-09). La base vuelve a calcular
 * es_fefo y rechaza lo caducado. Sin red se trabaja con la última lista guardada: solo el propuesto o la alternativa.
 */
import { randomId } from '../util.js';
import { api, ErrorApi, SinRed } from '../api.js';
import { estado, puede, tarea } from '../estado.js';
import { clasificar } from '../escaner/gs1.js';
import { campoEscaneo } from '../escaner/lector.js';
import { guardarCache, leerCache, registrar } from '../cola/cola.js';
import { avisar, corto, dias, fecha, h, MOTIVOS, nivel, pintar } from '../ui.js';
import { encabezado } from '../main.js';

interface Alternativa { id_lote: string; num_lote: string; id_tarima: string; id_posicion: string | null; caducidad_vigente: string; dias_de_diferencia: number }
interface Reserva { id_reserva: number; renglon: number; id_lote: string; id_tarima: string; cajas: number; num_lote: string; caducidad_vigente: string;
  id_posicion: string | null; zona: string | null; profundidad: number | null; tarimas_delante: number; bloqueada_por: string[]; dias_restantes: number; alternativa: Alternativa | null }
interface Renglon { renglon: number; sku: string; producto: string; cajas: number; surtidas: number; reservas: Reserva[]; faltante: number }
interface Lista { id_pedido: string; fecha: string; cliente_ref: string | null; estado: string; renglones: Renglon[]; salidas: Array<Record<string, unknown>> }

async function obtenerLista(id: string): Promise<{ lista: Lista; guardada: boolean }> {
  try {
    const lista = await api<Lista>('POST', '/listas-surtido', { id_pedido: id });
    await guardarCache(`lista:${id}`, lista);
    return { lista, guardada: false };
  } catch (e) {
    const l = e instanceof SinRed ? await leerCache<Lista>(`lista:${id}`) : undefined;
    if (!l) throw e instanceof SinRed ? new Error('Sin red y este pedido no está guardado en el teléfono.') : e;
    return { lista: l, guardada: true };
  }
}

export async function vistaPedidos() {
  encabezado('Surtir pedido');
  let pedidos: Array<{ id_pedido: string; fecha: string; cliente_ref: string | null; cancelado: boolean; cajas: number; surtidas: number }>;
  try {
    pedidos = await api('GET', '/pedidos');
  } catch (e) {
    if (!(e instanceof SinRed)) throw e;
    return pintar(h('div', { class: 'pend' }, 'Sin red: abre un pedido que ya hayas consultado en este teléfono.'));
  }
  const abiertos = pedidos.filter((p) => !p.cancelado && p.surtidas < p.cajas);
  pintar(
    puede('supervisor') ? h('a', { class: 'btn sec', href: '#/admin?panel=pedido', style: 'margin:0 0 14px' }, '+ Nuevo pedido') : null,
    abiertos.length ? null : h('div', { class: 'card tenue' }, 'No hay pedidos abiertos.'),
    abiertos.map((p) => h('a', { class: 'card', href: `#/surtir/${encodeURIComponent(p.id_pedido)}`, style: 'display:block;text-decoration:none;color:inherit' },
      h('div', { class: 'big', style: 'font-size:19px' }, p.id_pedido), h('div', { class: 'chico tenue' }, `${p.cliente_ref ?? 'Sin referencia'} · ${p.surtidas} de ${p.cajas} cajas`))));
}

export async function vistaPedido(id: string) {
  const { lista, guardada } = await obtenerLista(id);
  encabezado(`Surtido · ${lista.id_pedido}`, lista.cliente_ref ?? '');
  pintar(
    guardada ? h('div', { class: 'pend' }, 'Sin red: lista guardada en el teléfono. Puede haber cambiado.') : null,
    lista.estado !== 'abierto' ? h('div', { class: 'ok-msg' }, lista.estado === 'surtido' ? 'Pedido surtido completo.' : 'Pedido cancelado.') : null,
    lista.renglones.map((r) => h('div', { class: 'card' },
      h('h3', null, `${r.renglon}. ${r.producto}`),
      h('div', { class: 'chico tenue' }, `${r.surtidas} de ${r.cajas} cajas surtidas`),
      r.faltante > 0 && lista.estado === 'abierto' ? h('div', { class: 'warn' }, `Faltan ${r.faltante} cajas sin existencia disponible.`) : null,
      r.reservas.map((x) => h('a', { class: 'opt', href: `#/surtir/${encodeURIComponent(id)}/${r.renglon}?reserva=${x.id_reserva}`, style: 'margin-top:10px;text-decoration:none' },
        h('b', null, `${x.num_lote} · ${x.cajas} cajas`), ' en ', h('b', null, x.id_posicion ?? 'por ubicar'),
        x.tarimas_delante ? h('div', { class: 'chico', style: 'color:var(--aviso)' }, `Bloqueado por ${x.tarimas_delante} ${x.tarimas_delante === 1 ? 'tarima' : 'tarimas'}`) : null)))));
}

export async function vistaSurtir(idPedido: string, renglon: number, p: URLSearchParams) {
  const { lista } = await obtenerLista(idPedido);
  const r = lista.renglones.find((x) => x.renglon === renglon);
  const res = r?.reservas.find((x) => String(x.id_reserva) === p.get('reserva')) ?? r?.reservas[0];
  if (!r || !res) { location.hash = `#/surtir/${encodeURIComponent(idPedido)}`; return; }
  encabezado(`Surtido · ${idPedido}`, `Línea ${renglon} de ${lista.renglones.length} · ${r.producto}`);
  const contador = { n: 0 };
  const nivelRes = res.dias_restantes < 0 ? 'vencido' : null;

  // Fig. 11a: recomendación FEFO restringida por accesibilidad
  const tarjeta = h('div', { class: 'card propuesta' },
    h('div', { class: 'lbl' }, 'Lote FEFO propuesto (RN-01)'),
    h('div', { class: 'big' }, `${res.num_lote} · ${res.cajas} cajas`),
    h('div', { class: 'lbl' }, `Caduca ${fecha(res.caducidad_vigente)} · ${dias(res.dias_restantes)}`, ' ', nivel(nivelRes)),
    h('div', { class: 'lbl', style: 'margin-top:8px' }, 'Ubicación'),
    h('div', { class: 'big' }, res.id_posicion ?? 'Por ubicar'),
    h('div', { class: 'chico tenue mono' }, `Tarima ${res.id_tarima}`),
    res.tarimas_delante ? h('div', { class: 'warn' }, h('b', null, `Bloqueado por ${res.tarimas_delante} ${res.tarimas_delante === 1 ? 'tarima' : 'tarimas'}`),
      ` (${res.bloqueada_por.map(corto).join(', ')}). ${res.alternativa ? 'Muévalas o use la alternativa.' : 'Muévalas para llegar al lote.'}`) : null);
  const alt = res.alternativa;
  const tarjetaAlt = alt ? h('div', { class: 'card' },
    h('div', { class: 'lbl' }, 'Alternativa accesible'),
    h('div', { class: 'big', style: 'font-size:19px' }, `${alt.num_lote} · ${alt.id_posicion}`),
    h('div', { class: 'lbl' }, `Caduca ${fecha(alt.caducidad_vigente)} (+${alt.dias_de_diferencia} días). Requiere motivo.`)) : null;

  const zona = h('div');
  const cajas = h('input', { type: 'number', min: 1, max: res.cajas, value: res.cajas, inputmode: 'numeric' });

  // Lo que se escaneó: la tarima propuesta, la de la alternativa u otra (con red se consulta qué lote del producto trae)
  async function alEscanearTarima(v: string) {
    const l = clasificar(v);
    if (l.tipo !== 'tarima') return avisar('Escanea la etiqueta QR de la tarima.', 'error');
    if (l.valor === res!.id_tarima) return confirmarSalida({ id_lote: res!.id_lote, num_lote: res!.num_lote, id_tarima: l.valor });
    if (alt && l.valor === alt.id_tarima) return pedirMotivo({ id_lote: alt.id_lote, num_lote: alt.num_lote, id_tarima: l.valor }, 'tarima_inaccesible');
    try {
      const t = await api<{ lotes: Array<{ id_lote: string; num_lote: string; sku: string; cajas: number; caducidad_vigente: string }> }>('GET', `/tarimas/${l.valor}`);
      const delProducto = t.lotes.filter((x) => x.sku === r!.sku);
      if (!delProducto.length) return avisar(`La tarima ${corto(l.valor)} no tiene ${r!.producto}.`, 'error');
      const elegir = (x: typeof delProducto[number]) => (x.id_lote === res!.id_lote
        ? confirmarSalida({ id_lote: x.id_lote, num_lote: x.num_lote, id_tarima: l.valor })
        : pedirMotivo({ id_lote: x.id_lote, num_lote: x.num_lote, id_tarima: l.valor }));
      if (delProducto.length === 1) return elegir(delProducto[0]);
      zona.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'lbl' }, 'La tarima trae varios lotes de este producto. ¿Cuál tomaste?'),
        delProducto.map((x) => h('button', { class: 'opt', type: 'button', onclick: () => elegir(x) }, `${x.num_lote} · caduca ${fecha(x.caducidad_vigente)} · ${x.cajas} cajas`))));
    } catch (e) {
      avisar(e instanceof SinRed ? 'Sin red solo puedes tomar el lote propuesto o la alternativa.' : (e as ErrorApi).message, 'error');
    }
  }

  // Fig. 11b: motivo obligatorio cuando el lote difiere
  function pedirMotivo(lote: { id_lote: string; num_lote: string; id_tarima: string }, preseleccion?: string) {
    let motivo = preseleccion ?? '';
    const justificacion = h('input', { maxlength: 300, placeholder: 'Por qué se toma este lote' });
    const cajaJust = h('div', { hidden: motivo !== 'decision_operador' }, h('label', null, 'Justificación'), justificacion);
    const opciones = Object.entries(MOTIVOS).map(([clave, texto]) => {
      const b = h('button', { class: `opt${clave === motivo ? ' sel' : ''}`, type: 'button', onclick: () => {
        motivo = clave;
        opciones.forEach((o) => o.classList.toggle('sel', o === b));
        cajaJust.hidden = clave !== 'decision_operador';
      } }, texto);
      return b;
    });
    encabezado('Lote distinto al propuesto', `Escaneado: ${lote.num_lote} · propuesto: ${res!.num_lote}`);
    pintar(h('div', { class: 'card' }, 'La salida no es FEFO. Elija el motivo para continuar (RN-09). El caso queda en el reporte de excepciones.'),
      opciones, cajaJust, h('label', null, 'Cajas'), cajas,
      h('button', { class: 'btn', type: 'button', onclick: () => {
        if (!motivo) return avisar('Elige un motivo.', 'error');
        if (motivo === 'decision_operador' && !justificacion.value.trim()) return avisar('Escribe la justificación.', 'error');
        void confirmarSalida(lote, motivo, justificacion.value.trim());
      } }, 'Confirmar salida'),
      h('button', { class: 'btn sec', type: 'button', onclick: () => void vistaSurtir(idPedido, renglon, p) }, 'Volver'));
  }

  async function confirmarSalida(lote: { id_lote: string; num_lote: string; id_tarima: string }, motivo?: string, justificacion?: string) {
    const n = Number(cajas.value);
    if (!Number.isInteger(n) || n < 1 || n > res!.cajas) return avisar(`Las cajas deben ser de 1 a ${res!.cajas}.`, 'error');
    const resultado = await registrar({
      id_mov: randomId(), tipo: 'salida', id_tarima: lote.id_tarima, id_lote: lote.id_lote, cajas: n, motivo_excepcion: motivo ?? null,
      justificacion: justificacion || null, id_pedido: idPedido, renglon, id_reserva: res!.id_reserva, id_lote_propuesto: res!.id_lote,
      fecha_dispositivo: new Date().toISOString(), tarea: tarea.actual(), escaneos: contador.n,
    });
    if (resultado.estado === 'rechazado') {
      if (resultado.codigo === 'requiere_motivo') return pedirMotivo(lote);   // la base dice que no es FEFO (R6)
      if (resultado.codigo === 'caducado') return ofrecerBaja(lote, resultado.mensaje ?? '');
      return avisar(resultado.mensaje ?? 'Rechazado.', 'error');
    }
    if (resultado.estado === 'pendiente') {
      // Sin red: la reserva se da por tomada en la lista guardada; la base la confirmará al sincronizar
      const guardada = await leerCache<Lista>(`lista:${idPedido}`);
      const rg = guardada?.renglones.find((x) => x.renglon === renglon);
      if (guardada && rg) {
        rg.reservas = rg.reservas.filter((x) => x.id_reserva !== res!.id_reserva);
        rg.surtidas += n;
        await guardarCache(`lista:${idPedido}`, guardada);
      }
      avisar(`Guardado sin red: ${n} cajas de ${lote.num_lote}.`, 'info');
    } else {
      avisar(resultado.es_fefo ? `Salida FEFO registrada: ${n} cajas de ${lote.num_lote}.` : `Salida registrada como excepción (${MOTIVOS[motivo ?? ''] ?? motivo}).`);
    }
    location.hash = `#/surtir/${encodeURIComponent(idPedido)}`;
  }

  function ofrecerBaja(lote: { id_lote: string; num_lote: string; id_tarima: string }, mensaje: string) {
    zona.replaceChildren(h('div', { class: 'err-msg' }, mensaje),
      h('button', { class: 'btn peligro', type: 'button', onclick: async () => {
        try {
          await api('POST', '/bajas', { id_lote: lote.id_lote, id_tarima: lote.id_tarima, motivo: 'caducidad' });
          avisar(`Baja del lote ${lote.num_lote} propuesta; queda pendiente de autorización.`);
        } catch (e) { avisar((e as Error).message, 'error'); }
      } }, 'Proponer baja por caducidad (RF-16)'));
  }

  const escaneo = campoEscaneo({ etiqueta: 'Escanear tarima tomada', marcador: 'Etiqueta QR de la tarima', contador, alLeer: (v) => void alEscanearTarima(v) });
  pintar(estado.enLinea ? null : h('div', { class: 'pend' }, 'Sin red: la salida se guardará en el teléfono.'),
    tarjeta, tarjetaAlt, h('div', { class: 'card' }, escaneo.el, h('label', null, 'Cajas'), cajas), zona,
    h('a', { class: 'btn sec', href: `#/surtir/${encodeURIComponent(idPedido)}` }, 'Volver a la lista'));
  escaneo.entrada.focus();
}
