/** Estado del cliente: usuario de la sesión, identificador del dispositivo y tarea de evaluación en curso. */

export type Rol = 'almacenista' | 'supervisor' | 'administracion';
export interface Usuario { id_usuario: string; nombre: string; rol: Rol; aviso_aceptado_en: string | null }

const NIVEL: Record<Rol, number> = { almacenista: 1, supervisor: 2, administracion: 3 };

export const estado = {
  usuario: null as Usuario | null,
  enLinea: navigator.onLine,
};

export const puede = (minimo: Rol) => !!estado.usuario && NIVEL[estado.usuario.rol] >= NIVEL[minimo];

function guardado(clave: string): string | null {
  try { return localStorage.getItem(clave); } catch { return null; }
}
function guardar(clave: string, valor: string | null) {
  try { if (valor === null) localStorage.removeItem(clave); else localStorage.setItem(clave, valor); } catch { /* modo privado */ }
}

/** UUID estable del teléfono: cada movimiento lleva su dispositivo (OD7, tabla dispositivo de P3). */
export function idDispositivo(): string {
  let id = guardado('fefo.dispositivo');
  if (!id) {
    id = crypto.randomUUID();
    guardar('fefo.dispositivo', id);
  }
  return id;
}

/** Último usuario de este teléfono: permite abrir la aplicación sin red (la sesión se verifica al recuperarla). */
export const usuarioRecordado = {
  leer: (): Usuario | null => { try { return JSON.parse(guardado('fefo.usuario') ?? 'null'); } catch { return null; } },
  guardar: (u: Usuario | null) => guardar('fefo.usuario', u ? JSON.stringify(u) : null),
};

/** Código de la tarea de evaluación (P2 III.F): se adjunta a cada movimiento y búsqueda. */
export const tarea = {
  actual: () => guardado('fefo.tarea'),
  fijar: (codigo: string | null) => guardar('fefo.tarea', codigo),
};
