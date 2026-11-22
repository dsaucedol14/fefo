/** Inicio de sesión (RNF-08) y aviso de privacidad en el primer ingreso (RNF-09). */
import { api, ErrorApi, SinRed } from '../api.js';
import { estado, idDispositivo, usuarioRecordado, type Usuario } from '../estado.js';
import { h, pintar } from '../ui.js';

export function vistaLogin(listo: () => void) {
  const usuario = h('input', { id: 'usuario', autocomplete: 'username', autocapitalize: 'none', required: true });
  const contrasena = h('input', { id: 'contrasena', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('div', { class: 'err-msg', role: 'alert', hidden: true });
  const form = h('form', { class: 'card', onsubmit: async (e: Event) => {
    e.preventDefault();
    error.hidden = true;
    try {
      const u = await api<Usuario>('POST', '/sesiones', { usuario: usuario.value, contrasena: contrasena.value,
        id_dispositivo: idDispositivo(), descripcion_dispositivo: navigator.userAgent.replace(/^.*?\(([^)]*)\).*$/, '$1').slice(0, 60) });
      estado.usuario = u;
      usuarioRecordado.guardar(u);
      listo();
    } catch (err) {
      error.textContent = err instanceof SinRed ? 'Sin conexión con el servidor.' : (err as ErrorApi).message;
      error.hidden = false;
    }
  } },
  h('h2', null, 'Iniciar sesión'),
  h('p', { class: 'tenue chico' }, 'Trazabilidad de tarimas y control FEFO · prototipo académico'),
  error, h('label', { for: 'usuario' }, 'Usuario'), usuario, h('label', { for: 'contrasena' }, 'Contraseña'), contrasena,
  h('button', { class: 'btn', type: 'submit' }, 'Entrar'));
  pintar(form);
  usuario.focus();
}

export function vistaAviso(listo?: () => void) {
  pintar(h('div', { class: 'card' },
    h('h2', null, 'Aviso de privacidad'),
    h('p', { class: 'tenue chico' }, 'Ley Federal de Protección de Datos Personales en Posesión de los Particulares (DOF 20 mar. 2025)'),
    h('p', null, h('b', null, 'Qué datos se tratan: '), 'solo tu nombre, tu usuario y tu rol, y el registro de las operaciones que haces (fecha y hora, teléfono, tarima, lote, escaneos y resultado).'),
    h('p', null, h('b', null, 'Para qué: '), 'controlar las operaciones del almacén y evaluar el prototipo del estudio académico de la Universidad del Sur. En los análisis tus operaciones se identifican con tu código de usuario, nunca con tu nombre.'),
    h('p', null, h('b', null, 'Transferencias: '), 'no se comparten con terceros; los resultados se publican agregados.'),
    h('p', null, h('b', null, 'Tus derechos: '), 'acceso, rectificación, cancelación u oposición, y retirarte del estudio sin consecuencias, con el supervisor o el equipo de investigación.'),
    h('p', null, h('b', null, 'Conservación: '), 'la bitácora no se puede editar para que sirva como evidencia; al terminar el estudio se entrega anonimizada.'),
    h('button', { class: 'btn', onclick: async () => { await api('POST', '/aviso'); if (listo) listo(); else location.reload(); } }, 'Leí el aviso y continúo')));
}
