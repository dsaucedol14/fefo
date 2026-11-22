/** Arranque de la PWA: encabezado con estado de red y pendientes, navegación por rol y enrutador por hash. */
import './estilos.css';
import { registerSW } from 'virtual:pwa-register';
import { api, alErrorDeSesion, SinRed } from './api.js';
import { estado, puede, tarea, usuarioRecordado, type Usuario } from './estado.js';
import { alCambiar, enCola, iniciarSincronizador, refrescarPosiciones, sincronizar } from './cola/cola.js';
import { h } from './ui.js';
import { vistaLogin, vistaAviso } from './vistas/acceso.js';
import { vistaInicio } from './vistas/inicio.js';
import { vistaRecepcion } from './vistas/recepcion.js';
import { vistaMover } from './vistas/mover.js';
import { vistaPedidos, vistaPedido, vistaSurtir } from './vistas/surtir.js';
import { vistaBuscar, vistaTarima } from './vistas/buscar.js';
import { vistaAlertas } from './vistas/alertas.js';
import { vistaMapa } from './vistas/mapa.js';
import { vistaAdmin } from './vistas/admin.js';
import { vistaPendientes } from './vistas/pendientes.js';

registerSW({ immediate: true });

let titulo = 'FEFO Tarimas';
let subtitulo = '';
export function encabezado(t: string, s = '') {
  titulo = t;
  subtitulo = s;
  void pintarBarra();
}

const MENU: Array<[string, string, Parameters<typeof puede>[0]]> = [
  ['#/', 'Inicio', 'almacenista'], ['#/recibir', 'Recibir', 'almacenista'], ['#/mover', 'Ubicar / mover', 'almacenista'],
  ['#/surtir', 'Surtir', 'almacenista'], ['#/buscar', 'Buscar', 'almacenista'], ['#/alertas', 'Alertas', 'supervisor'],
  ['#/mapa', 'Mapa', 'almacenista'], ['#/admin', 'Supervisión', 'supervisor'],
];

async function pintarBarra() {
  const barra = document.getElementById('barra')!;
  const cola = await enCola().catch(() => []);
  const pendientes = cola.filter((x) => x.estado === 'pendiente').length;
  const rechazados = cola.length - pendientes;
  const red = h('span', { class: `red${estado.enLinea ? '' : ' sin'}` }, estado.enLinea ? 'En línea' : 'Sin red');
  const ruta = location.hash.split('?')[0] || '#/';
  barra.replaceChildren(h('div', null,
    h('div', { class: 'fila' }, h('h1', null, titulo, subtitulo ? h('small', null, subtitulo) : null), red),
    estado.usuario ? h('nav', { class: 'nav', 'aria-label': 'Principal' },
      MENU.filter(([, , r]) => puede(r)).map(([href, texto]) =>
        h('a', { href, class: (href === '#/' ? ruta === '#/' : ruta.startsWith(href)) ? 'activo' : '' }, texto)),
      pendientes || rechazados ? h('a', { href: '#/pendientes', class: ruta === '#/pendientes' ? 'activo' : '' },
        `Pendientes ${pendientes}${rechazados ? ` · ${rechazados} con error` : ''}`) : null,
      h('a', { href: '#/salir' }, 'Salir')) : null));
  const t = tarea.actual();
  const franja = document.getElementById('tarea')!;
  franja.hidden = !t || !estado.usuario;
  franja.replaceChildren(h('span', null, 'Tarea de evaluación ', h('b', null, t ?? '')), h('a', { href: '#/admin?panel=evaluacion' }, 'cambiar'));
}

type Vista = (parametros: URLSearchParams, partes: string[]) => Promise<void> | void;
const RUTAS: Record<string, Vista> = {
  '': vistaInicio, recibir: vistaRecepcion, mover: vistaMover, surtir: (p, partes) => (partes[1] && partes[2] ? vistaSurtir(partes[1], Number(partes[2]), p)
    : partes[1] ? vistaPedido(partes[1]) : vistaPedidos()),
  buscar: vistaBuscar, tarima: (p, partes) => vistaTarima(partes[1]), alertas: vistaAlertas, mapa: vistaMapa, admin: vistaAdmin,
  pendientes: vistaPendientes,
};

async function enrutar() {
  const [ruta, consulta] = (location.hash.replace(/^#\/?/, '') || '').split('?');
  const partes = ruta.split('/').map(decodeURIComponent);
  const parametros = new URLSearchParams(consulta ?? '');
  if (partes[0] === 'salir') {
    const pendientes = (await enCola()).filter((x) => x.estado === 'pendiente').length;
    if (pendientes && !confirm(`Hay ${pendientes} movimientos sin enviar. Si sales, se enviarán cuando vuelvas a entrar. ¿Salir?`)) {
      history.back();
      return;
    }
    await api('DELETE', '/sesiones').catch(() => {});
    estado.usuario = null;
    usuarioRecordado.guardar(null);
    location.hash = '#/';
    return;
  }
  if (!estado.usuario) {
    try {
      estado.usuario = await api<Usuario>('GET', '/sesiones/actual');
      usuarioRecordado.guardar(estado.usuario);
    } catch (e) {
      if ((e as { codigo?: string }).codigo === 'aviso_pendiente') return vistaAviso();
      const recordado = usuarioRecordado.leer();
      if (e instanceof SinRed && recordado) {
        estado.usuario = recordado;            // sin red: se trabaja con la cola; la sesión se valida al sincronizar
      } else {
        usuarioRecordado.guardar(null);
        encabezado('FEFO Tarimas');
        return vistaLogin(() => enrutar());
      }
    }
  }
  if (!estado.usuario.aviso_aceptado_en) return vistaAviso(() => { estado.usuario!.aviso_aceptado_en = new Date().toISOString(); void enrutar(); });
  encabezado('FEFO Tarimas', estado.usuario.nombre);
  const vista = RUTAS[partes[0]] ?? vistaInicio;
  try {
    await vista(parametros, partes);
  } catch (e) {
    document.querySelector('main')!.replaceChildren(h('div', { class: 'err-msg' }, (e as Error).message));
  }
  void pintarBarra();
}

// Sesión vencida mientras se trabajaba: volver al inicio de sesión (la consulta inicial ya maneja su propio 401)
alErrorDeSesion((e) => {
  if (e.codigo === 'sin_sesion' && estado.usuario) {
    estado.usuario = null;
    usuarioRecordado.guardar(null);
    void enrutar();
  }
});
alCambiar(() => { void pintarBarra(); });
const cambioRed = () => { estado.enLinea = navigator.onLine; void pintarBarra(); if (navigator.onLine) void refrescarPosiciones(); };
window.addEventListener('online', cambioRed);
window.addEventListener('offline', cambioRed);
window.addEventListener('hashchange', () => { void enrutar(); });
iniciarSincronizador();
void enrutar().then(() => { if (estado.usuario) { void sincronizar(); void refrescarPosiciones(); } });
