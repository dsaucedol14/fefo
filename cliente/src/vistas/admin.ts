/**
 * Supervisión (CU-12 y evidencia para P4): pedido nuevo, tarea de evaluación del teléfono, umbrales U(c) por
 * categoría (RNF-11), usuarios (RF-21), rechazos de sincronización (ADR-004), exportes CSV y etiquetas de posición.
 */
import { api, urlApi } from '../api.js';
import { estado, puede, tarea } from '../estado.js';
import { avisar, h, pintar } from '../ui.js';
import { encabezado } from '../main.js';

const PANELES: Array<[string, string]> = [['pedido', 'Nuevo pedido'], ['evaluacion', 'Evaluación'], ['umbrales', 'Umbrales'], ['usuarios', 'Usuarios'], ['etiquetas', 'Etiquetas']];

export async function vistaAdmin(p: URLSearchParams) {
  const panel = p.get('panel') ?? (puede('supervisor') ? 'pedido' : 'evaluacion');
  encabezado('Supervisión');
  const nav = h('nav', { class: 'cifras', style: 'margin-bottom:14px' },
    PANELES.filter(([k]) => puede('supervisor') || k === 'evaluacion').map(([k, t]) => h('a', { class: `cifra${k === panel ? ' sel' : ''}`, href: `#/admin?panel=${k}` }, t)));
  const cuerpo = h('div');
  pintar(nav, cuerpo);
  const f = { pedido: panelPedido, evaluacion: panelEvaluacion, umbrales: panelUmbrales, usuarios: panelUsuarios, etiquetas: panelEtiquetas }[panel] ?? panelEvaluacion;
  await f(cuerpo);
}

async function panelPedido(c: HTMLElement) {
  const productos = await api<Array<{ sku: string; nombre: string }>>('GET', '/productos');
  const lineas = [{ sku: '', cajas: '' }];
  const ref = h('input', { maxlength: 40, placeholder: 'Opcional; p. ej. escenario FEFO-07' });
  const lista = h('div');
  const dibujar = () => lista.replaceChildren(...lineas.map((l, i) => h('div', { class: 'renglon' },
    lineas.length > 1 ? h('button', { class: 'quitar', type: 'button', onclick: () => { lineas.splice(i, 1); dibujar(); } }, 'Quitar') : null,
    h('label', null, `Renglón ${i + 1}`),
    h('select', { onchange: (e: Event) => { l.sku = (e.target as HTMLSelectElement).value; } }, h('option', { value: '' }, 'Producto'),
      productos.map((x) => h('option', { value: x.sku, selected: x.sku === l.sku }, `${x.nombre} · ${x.sku}`))),
    h('label', null, 'Cajas'), h('input', { type: 'number', min: 1, value: l.cajas, inputmode: 'numeric', oninput: (e: Event) => { l.cajas = (e.target as HTMLInputElement).value; } }))));
  dibujar();
  c.replaceChildren(h('div', { class: 'card' }, h('label', null, 'Cliente o referencia'), ref), lista,
    h('button', { class: 'btn sec', type: 'button', onclick: () => { lineas.push({ sku: '', cajas: '' }); dibujar(); } }, '+ Renglón'),
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      try {
        const r = await api<{ id_pedido: string }>('POST', '/pedidos', { cliente_ref: ref.value || undefined, lineas: lineas.map((l) => ({ sku: l.sku, cajas: Number(l.cajas) })) });
        avisar(`Pedido ${r.id_pedido} creado con su lista FEFO.`);
        location.hash = `#/surtir/${encodeURIComponent(r.id_pedido)}`;
      } catch (e) { avisar((e as Error).message, 'error'); }
    } }, 'Crear pedido y lista de surtido'));
}

async function panelEvaluacion(c: HTMLElement) {
  const actual = tarea.actual();
  const codigo = h('input', { value: actual ?? '', placeholder: 'Ej. T-017 o FEFO-07', maxlength: 30, pattern: '[A-Za-z0-9._\\-]+', autocapitalize: 'characters' });
  const cambiar = async (nuevo: string | null) => {
    if (actual) await api('POST', '/eventos', { tipo: 'tarea_fin', tarea: actual, fecha_dispositivo: new Date().toISOString() }).catch(() => {});
    tarea.fijar(nuevo);
    if (nuevo) await api('POST', '/eventos', { tipo: 'tarea_inicio', tarea: nuevo, fecha_dispositivo: new Date().toISOString() }).catch(() => {});
    avisar(nuevo ? `Tarea ${nuevo} en curso en este teléfono.` : 'Tarea terminada.');
    void vistaAdmin(new URLSearchParams('panel=evaluacion'));
  };
  c.replaceChildren(h('div', { class: 'card' },
    h('h3', null, 'Tarea de evaluación en este teléfono'),
    h('p', { class: 'chico tenue' }, 'El observador fija el código antes de entregar la solicitud por escrito (P2 III.F). Cada movimiento y búsqueda queda ligado a él, con el usuario, el teléfono y la hora.'),
    codigo,
    h('div', { class: 'btn-linea' },
      h('button', { class: 'btn', type: 'button', onclick: () => { const v = codigo.value.trim().toUpperCase(); if (!/^[A-Z0-9._-]{1,30}$/.test(v)) return avisar('Usa letras, números, punto o guion.', 'error'); void cambiar(v); } }, actual ? 'Cambiar tarea' : 'Iniciar tarea'),
      actual ? h('button', { class: 'btn sec', type: 'button', onclick: () => void cambiar(null) }, 'Terminar') : null)));
  if (!puede('supervisor')) return;
  const [tareas, rechazos] = await Promise.all([
    api<Array<{ tarea: string; movimientos: number; salidas: number; salidas_fefo: number; inicio: string }>>('GET', '/evaluacion/tareas'),
    api<Array<{ id: number; id_usuario: string; codigo: string; mensaje: string; fecha_dispositivo: string }>>('GET', '/evaluacion/rechazos'),
  ]);
  c.append(
    h('div', { class: 'card' }, h('h3', null, 'Exportes para el análisis (P4)'), h('p', { class: 'chico tenue' }, 'Usuarios por código, nunca por nombre.'),
      h('div', { class: 'btn-linea' }, ['movimientos', 'eventos', 'bitacora'].map((n) => h('a', { class: 'btn sec', href: urlApi(`/exportes/${n}.csv`) }, `${n}.csv`)))),
    h('div', { class: 'card desplazable' }, h('h3', null, 'Tareas registradas'), tareas.length ? h('table', { class: 'tabla' },
      h('tr', null, h('th', null, 'Tarea'), h('th', null, 'Movs.'), h('th', null, 'Salidas FEFO')),
      tareas.map((t) => h('tr', null, h('td', { class: 'mono' }, t.tarea), h('td', null, t.movimientos), h('td', null, t.salidas ? `${t.salidas_fefo} de ${t.salidas}` : '—')))) : h('p', { class: 'tenue' }, 'Aún no hay tareas.')),
    h('div', { class: 'card' }, h('h3', null, 'Rechazos de sincronización (ADR-004)'), rechazos.length
      ? rechazos.map((r) => h('div', { class: 'fila-dato chico' }, h('span', null, `${r.id_usuario}: ${r.mensaje}`), h('span', null, new Date(r.fecha_dispositivo).toLocaleString('es-MX'))))
      : h('p', { class: 'tenue' }, 'Ninguno.')));
}

async function panelUmbrales(c: HTMLElement) {
  const cats = await api<Array<{ id_categoria: number; nombre: string; conservacion: string; vu_dias: number; vmr_dias: number; tr_dias: number; ms_dias: number; umbral_dias: number }>>('GET', '/categorias');
  c.replaceChildren(h('p', { class: 'chico tenue' }, 'U(c) = mín{VU, VMR + TR + MS}. Los cambios aplican de inmediato a las alertas y quedan en la bitácora (RNF-11).'),
    ...cats.map((k) => {
      const campo = (n: 'vu_dias' | 'vmr_dias' | 'tr_dias' | 'ms_dias', t: string) => h('div', { style: 'flex:1' }, h('label', null, t), h('input', { type: 'number', min: 0, value: k[n], 'data-campo': n }));
      const forma = h('div', { class: 'card' }, h('h3', null, `${k.nombre} · ${k.conservacion} · U = ${k.umbral_dias} días`),
        h('div', { class: 'btn-linea' }, campo('vu_dias', 'VU'), campo('vmr_dias', 'VMR'), campo('tr_dias', 'TR'), campo('ms_dias', 'MS')),
        h('button', { class: 'btn sec', type: 'button', onclick: async () => {
          const v = Object.fromEntries([...forma.querySelectorAll<HTMLInputElement>('input')].map((i) => [i.dataset.campo, Number(i.value)]));
          try { const r = await api<{ umbral_dias: number }>('PUT', `/categorias/${k.id_categoria}`, v); avisar(`${k.nombre}: U = ${r.umbral_dias} días.`); void panelUmbrales(c); }
          catch (e) { avisar((e as Error).message, 'error'); }
        } }, 'Guardar'));
      return forma;
    }));
}

async function panelUsuarios(c: HTMLElement) {
  const esAdmin = estado.usuario?.rol === 'administracion';
  const us = esAdmin ? await api<Array<{ id_usuario: string; nombre: string; rol: string; bloqueado: boolean; activo: boolean; intentos_fallidos: number }>>('GET', '/usuarios') : [];
  const desbloquear = h('input', { placeholder: 'Usuario bloqueado (p. ej. alm02)', autocapitalize: 'none' });
  c.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Desbloquear cuenta'), h('p', { class: 'chico tenue' }, 'Una cuenta se bloquea al 5.º intento fallido (RNF-08).'), desbloquear,
    h('button', { class: 'btn sec', type: 'button', onclick: async () => {
      try { await api('PUT', `/usuarios/${encodeURIComponent(desbloquear.value.trim().toLowerCase())}`, { desbloquear: true }); avisar('Cuenta desbloqueada.'); } catch (e) { avisar((e as Error).message, 'error'); }
    } }, 'Desbloquear')));
  if (!esAdmin) return;
  const nuevo = { id: h('input', { placeholder: 'alm03', autocapitalize: 'none' }), nombre: h('input', { placeholder: 'Almacenista 3' }),
    rol: h('select', null, ['almacenista', 'supervisor', 'administracion'].map((r) => h('option', { value: r }, r))), clave: h('input', { type: 'password', minlength: 8 }) };
  c.append(
    h('div', { class: 'card desplazable' }, h('h3', null, 'Usuarios'), h('table', { class: 'tabla' }, h('tr', null, h('th', null, 'Usuario'), h('th', null, 'Rol'), h('th', null, 'Estado')),
      us.map((u) => h('tr', null, h('td', null, `${u.id_usuario} · ${u.nombre}`), h('td', null, u.rol), h('td', null, !u.activo ? 'Inactivo' : u.bloqueado ? 'Bloqueado' : 'Activo'))))),
    h('div', { class: 'card' }, h('h3', null, 'Nuevo usuario'), h('p', { class: 'chico tenue' }, 'Usa códigos (alm03) en lugar de nombres reales (RNF-09).'),
      h('label', null, 'Usuario'), nuevo.id, h('label', null, 'Nombre'), nuevo.nombre, h('label', null, 'Rol'), nuevo.rol, h('label', null, 'Contraseña inicial (≥ 8)'), nuevo.clave,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        try {
          await api('POST', '/usuarios', { id_usuario: nuevo.id.value.trim().toLowerCase(), nombre: nuevo.nombre.value.trim(), rol: nuevo.rol.value, contrasena: nuevo.clave.value });
          avisar('Usuario creado.');
          void panelUsuarios(c);
        } catch (e) { avisar((e as Error).message, 'error'); }
      } }, 'Crear')));
}

function panelEtiquetas(c: HTMLElement) {
  c.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Etiquetas QR de posiciones (RN-04)'), h('p', { class: 'chico tenue' }, 'PDF tamaño carta, 18 etiquetas de 62 × 38 mm por hoja.'),
    ['A', 'B', 'C'].map((z) => h('a', { class: 'btn sec', href: urlApi(`/etiquetas/posiciones?zona=${z}`), target: '_blank', rel: 'noopener' }, `Zona ${z}`))));
}
