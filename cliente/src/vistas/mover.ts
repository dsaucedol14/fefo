/**
 * CU-02 Ubicar y CU-03 Reubicar (RF-05, RF-06, RF-08, RNF-03): escanear tarima → escanear posición → confirmar
 * (≤ 3 toques, 2 escaneos). Con red se muestran las posiciones sugeridas; sin red el movimiento entra a la cola con
 * el origen que el teléfono conoce y la base lo valida al sincronizar (rechaza origen desactualizado, ocupada, RN-05).
 */
import { randomId } from '../util.js';
import { api, ErrorApi, SinRed } from '../api.js';
import { estado, tarea } from '../estado.js';
import { clasificar } from '../escaner/gs1.js';
import { campoEscaneo } from '../escaner/lector.js';
import { anotarPosicion, posicionConocida, registrar } from '../cola/cola.js';
import { avisar, corto, h, pintar } from '../ui.js';
import { encabezado } from '../main.js';

interface Sugerencia { criterio: string; posiciones: Array<{ id_posicion: string; zona: string; profundidad: number }> }

export async function vistaMover(p: URLSearchParams) {
  encabezado('Ubicar o mover tarima', estado.enLinea ? '' : 'Sin red: se guardará en el teléfono');
  const contador = { n: 0 };
  let tarimaId = p.get('tarima') ?? '';
  let origen: string | null = null;
  let estadoTarima = '';
  const datos = h('div');
  const resultado = h('div');
  const pasos = h('ol', { class: 'pasos', 'aria-label': 'Pasos' }, h('li', null, 'Tarima'), h('li', null, 'Destino'), h('li', null, 'Confirmar'));
  const paso = (n: number) => [...pasos.children].forEach((li, i) => {
    li.className = i < n ? 'hecho' : i === n ? 'actual' : '';
    if (i === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  paso(0);

  async function cargarTarima(id: string) {
    resultado.replaceChildren();
    paso(0);
    tarimaId = id;
    try {
      const t = await api<{ id_tarima: string; id_posicion: string | null; estado: string; lotes: Array<{ producto: string; num_lote: string; cajas: number }> }>('GET', `/tarimas/${id}`);
      if (t.estado === 'vacia') { datos.replaceChildren(h('div', { class: 'err-msg' }, 'Esa tarima ya salió del almacén (vacía).')); return; }
      origen = t.id_posicion;
      estadoTarima = t.estado;
      await anotarPosicion(id, origen, t.estado);
      datos.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'fila-dato' }, h('span', null, 'Tarima'), h('b', { class: 'mono' }, t.id_tarima)),
        h('div', { class: 'fila-dato' }, h('span', null, 'Origen'), h('b', null, origen ?? 'Por ubicar')),
        h('div', { class: 'chico tenue' }, t.lotes.map((l) => `${l.producto} · ${l.num_lote} · ${l.cajas} cajas`).join(' — '))));
      const s = await api<Sugerencia>('GET', `/posiciones/sugerencia?tarima=${id}`).catch(() => null);
      if (s) datos.append(h('div', { class: 'card' }, h('div', { class: 'lbl' }, 'Posiciones sugeridas (RF-05)'), h('div', { class: 'chico' }, s.criterio),
        s.posiciones.length
          ? h('div', { class: 'chips' }, s.posiciones.map((x) => h('span', { class: 'chip mono' }, x.id_posicion)))
          : h('div', { class: 'warn' }, 'No hay posiciones libres compatibles')));
    } catch (e) {
      if (!(e instanceof SinRed)) { datos.replaceChildren(h('div', { class: 'err-msg' }, (e as ErrorApi).message)); return; }
      const conocida = await posicionConocida(id);
      if (!conocida) { datos.replaceChildren(h('div', { class: 'err-msg' }, 'Sin red y el teléfono no conoce esta tarima. Muévela cuando vuelva la señal.')); return; }
      origen = conocida.id_posicion;
      estadoTarima = conocida.estado;
      datos.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'fila-dato' }, h('span', null, 'Tarima'), h('b', { class: 'mono' }, id)),
        h('div', { class: 'fila-dato' }, h('span', null, 'Origen (según el teléfono)'), h('b', null, origen ?? 'Por ubicar'))));
    }
    tarjetaDestino.hidden = false;
    paso(1);
    destino.entrada.focus();
  }

  const tarimaCampo = campoEscaneo({ etiqueta: '1. Tarima', marcador: 'Escanea la etiqueta de la tarima', contador, enfocar: !tarimaId, valor: tarimaId, alLeer: (v) => {
    const l = clasificar(v);
    if (l.tipo !== 'tarima') return avisar('Eso no es una etiqueta de tarima (18 dígitos).', 'error');
    void cargarTarima(l.valor);
  } });
  let destinoElegido = '';
  const confirmar = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => void mover() }, 'Confirmar');
  const destino = campoEscaneo({ etiqueta: '2. Posición destino', marcador: 'Ej. B-F07-D3', contador, alLeer: (v) => {
    const l = clasificar(v);
    if (l.tipo !== 'posicion') return avisar('Eso no es una etiqueta de posición.', 'error');
    destinoElegido = l.valor;
    destino.entrada.value = l.valor;
    confirmar.disabled = false;
    confirmar.textContent = `Confirmar ${origen ? 'movimiento' : 'ubicación'} en ${l.valor}`;
    paso(2);
    confirmar.focus();
  } });

  async function mover() {
    confirmar.disabled = true;
    const tipo = origen ? 'reubicacion' : 'ubicacion';
    const r = await registrar({ id_mov: randomId(), tipo, id_tarima: tarimaId, pos_origen: origen, pos_destino: destinoElegido,
      fecha_dispositivo: new Date().toISOString(), tarea: tarea.actual(), escaneos: contador.n });
    if (r.estado === 'rechazado') {
      avisar(r.mensaje ?? 'Rechazado.', 'error');
      resultado.replaceChildren(h('div', { class: 'err-msg' }, r.mensaje ?? ''));
      if (r.codigo === 'origen_desactualizado') void cargarTarima(tarimaId);
      return;
    }
    await anotarPosicion(tarimaId, destinoElegido, 'ubicada');
    avisar(r.estado === 'pendiente' ? `Guardado sin red: ${corto(tarimaId)} → ${destinoElegido}` : `${corto(tarimaId)} ${tipo === 'ubicacion' ? 'ubicada' : 'movida'} en ${destinoElegido}`,
      r.estado === 'pendiente' ? 'info' : 'ok');
    void vistaMover(new URLSearchParams());
  }

  const tarjetaDestino = h('div', { class: 'card', hidden: true }, destino.el);
  pintar(pasos, h('div', { class: 'card' }, tarimaCampo.el), datos, tarjetaDestino, confirmar, resultado);
  if (tarimaId) void cargarTarima(tarimaId);
}
