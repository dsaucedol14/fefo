/**
 * CU-01 Recibir tarima y lotes (RF-01 a RF-04, RN-03): escanear cada caja (GS1-128) o capturar a mano; si la vida
 * remanente no alcanza, autoriza un supervisor; al terminar se imprime la etiqueta QR y se ubica la tarima.
 * La recepción necesita red (el servidor asigna el ID con su dígito verificador).
 */
import { api, ErrorApi, SinRed, urlApi } from '../api.js';
import { estado, puede, tarea } from '../estado.js';
import { leerGs1 } from '../escaner/gs1.js';
import { campoEscaneo } from '../escaner/lector.js';
import { anotarPosicion } from '../cola/cola.js';
import { avisar, fecha, h, pintar } from '../ui.js';

interface Producto { sku: string; nombre: string; requiere_frio: boolean }
interface Renglon { sku: string; num_lote: string; fecha_caducidad: string; cajas: string }

export async function vistaRecepcion() {
  if (!estado.enLinea) {
    pintar(h('div', { class: 'pend' }, 'La recepción necesita red: el servidor asigna el ID de la tarima. Ubica o mueve tarimas mientras vuelve la señal.'));
    return;
  }
  const productos = await api<Producto[]>('GET', '/productos');
  const renglones: Renglon[] = [{ sku: '', num_lote: '', fecha_caducidad: '', cajas: '' }];
  const contador = { n: 0 };
  let autorizacion: { propia?: boolean; usuario?: string; contrasena?: string } | undefined;
  const mensaje = h('div', { class: 'tenue chico' }, 'Si la caja trae GS1-128 con lote (10) y caducidad (17), se llenan solos.');
  const lista = h('div');
  const avisos = h('div');

  const caja = campoEscaneo({ etiqueta: 'Escanear caja', marcador: 'Código de la caja', contador, enfocar: true, alLeer: async (v) => {
    caja.entrada.value = '';
    const g = leerGs1(v);
    if (!g) { mensaje.textContent = 'No es un código GS1 con GTIN. Elige el producto y captura lote y caducidad.'; return; }
    const [p] = await api<Producto[]>('GET', `/productos?gtin=${g.gtin}`);
    if (!p) { mensaje.textContent = `El GTIN ${g.gtin} no está en el catálogo.`; return; }
    let r = renglones.find((x) => x.sku === p.sku && x.num_lote === (g.lote ?? '') && x.fecha_caducidad === (g.caducidad ?? ''));
    if (!r) {
      r = renglones.find((x) => !x.sku) ?? (renglones.push({ sku: '', num_lote: '', fecha_caducidad: '', cajas: '' }), renglones[renglones.length - 1]);
      Object.assign(r, { sku: p.sku, num_lote: g.lote ?? '', fecha_caducidad: g.caducidad ?? '' });
    }
    r.cajas = String((Number(r.cajas) || 0) + 1);       // cada caja escaneada suma una
    mensaje.textContent = `${p.nombre}${g.lote ? ` · lote ${g.lote}` : ' · captura el lote'}${g.caducidad ? ` · caduca ${fecha(g.caducidad)}` : ' · captura la caducidad'}`;
    dibujar();
  } });

  function dibujar() {
    lista.replaceChildren(...renglones.map((r, i) => h('fieldset', { class: 'renglon' },
      h('legend', { class: 'tenue chico' }, `Lote ${i + 1}`),
      renglones.length > 1 ? h('button', { class: 'quitar', type: 'button', onclick: () => { renglones.splice(i, 1); dibujar(); } }, 'Quitar') : null,
      h('label', null, 'Producto'),
      h('select', { required: true, onchange: (e: Event) => { r.sku = (e.target as HTMLSelectElement).value; } },
        h('option', { value: '' }, 'Elige el producto'),
        productos.map((p) => h('option', { value: p.sku, selected: p.sku === r.sku }, `${p.nombre} · ${p.sku}${p.requiere_frio ? ' · frío' : ''}`))),
      h('label', null, 'Número de lote'),
      h('input', { value: r.num_lote, maxlength: 20, required: true, autocapitalize: 'characters', oninput: (e: Event) => { r.num_lote = (e.target as HTMLInputElement).value; } }),
      h('div', { class: 'btn-linea' },
        h('div', { style: 'flex:2' }, h('label', null, 'Caducidad'),
          h('input', { type: 'date', value: r.fecha_caducidad, required: true, oninput: (e: Event) => { r.fecha_caducidad = (e.target as HTMLInputElement).value; } })),
        h('div', { style: 'flex:1' }, h('label', null, 'Cajas'),
          h('input', { type: 'number', min: 1, max: 9999, inputmode: 'numeric', value: r.cajas, required: true, oninput: (e: Event) => { r.cajas = (e.target as HTMLInputElement).value; } }))))));
  }

  async function enviar(e: Event) {
    e.preventDefault();
    try {
      const t = await api<{ id_tarima: string; lotes: Array<{ num_lote: string }> }>('POST', '/recepciones', {
        lotes: renglones.map((r) => ({ sku: r.sku, num_lote: r.num_lote.trim(), fecha_caducidad: r.fecha_caducidad, cajas: Number(r.cajas) })),
        autorizacion, tarea: tarea.actual() ?? undefined, escaneos: contador.n,
      });
      await anotarPosicion(t.id_tarima, null, 'por_ubicar');
      avisar('Tarima recibida.');
      pintar(h('div', { class: 'card propuesta' },
        h('div', { class: 'lbl' }, 'Tarima recibida · por ubicar'),
        h('div', { class: 'big mono' }, t.id_tarima),
        h('div', { class: 'chico' }, `${t.lotes.length} ${t.lotes.length === 1 ? 'lote' : 'lotes'}: ${t.lotes.map((l) => l.num_lote).join(', ')}`),
        h('a', { class: 'btn sec', href: urlApi(`/etiquetas/tarimas/${t.id_tarima}`), target: '_blank', rel: 'noopener' }, 'Imprimir etiqueta QR'),
        h('a', { class: 'btn', href: `#/mover?tarima=${t.id_tarima}` }, 'Ubicar ahora'),
        h('button', { class: 'btn sec', type: 'button', onclick: () => { void vistaRecepcion(); } }, 'Recibir otra')));
    } catch (err) {
      if (err instanceof SinRed) return avisar('Sin red: la recepción no se pudo enviar.', 'error');
      const ea = err as ErrorApi;
      if (ea.codigo === 'requiere_autorizacion') return pedirAutorizacion(ea.datos.avisos as Array<{ num_lote: string; dias: number; minimo: number }>);
      avisar(ea.message, 'error');
    }
  }

  function pedirAutorizacion(lista: Array<{ num_lote: string; dias: number; minimo: number }>) {
    const usuario = h('input', { autocapitalize: 'none', autocomplete: 'off' });
    const contrasena = h('input', { type: 'password', autocomplete: 'off' });
    avisos.replaceChildren(h('div', { class: 'warn', role: 'alert' },
      h('b', null, 'Vida remanente por debajo del mínimo (RN-03)'),
      h('ul', null, lista.map((a) => h('li', null, `Lote ${a.num_lote}: quedan ${a.dias} días; el mínimo es ${a.minimo}.`))),
      puede('supervisor')
        ? h('button', { class: 'btn', type: 'button', onclick: (e: Event) => { autorizacion = { propia: true }; void enviar(e); } }, 'Autorizo recibirlos')
        : h('div', null, h('label', null, 'Usuario del supervisor'), usuario, h('label', null, 'Contraseña del supervisor'), contrasena,
          h('button', { class: 'btn', type: 'button', onclick: (e: Event) => { autorizacion = { usuario: usuario.value, contrasena: contrasena.value }; void enviar(e); } }, 'Autorizar y recibir'))));
    avisos.scrollIntoView({ behavior: 'smooth' });
  }

  dibujar();
  pintar(h('div', { class: 'card' }, caja.el, mensaje),
    h('form', { onsubmit: enviar }, lista,
      h('button', { class: 'btn sec', type: 'button', onclick: () => { renglones.push({ sku: '', num_lote: '', fecha_caducidad: '', cajas: '' }); dibujar(); } }, '+ Agregar otro lote'),
      avisos,
      h('button', { class: 'btn', type: 'submit' }, 'Recibir tarima')));
}
