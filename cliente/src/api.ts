/** Cliente de la API REST (JSON sobre HTTPS, misma procedencia; la cookie de sesión es HttpOnly). */
import { idDispositivo } from './estado.js';

export class ErrorApi extends Error {
  constructor(public estado: number, public codigo: string, mensaje: string, public datos: Record<string, unknown> = {}) {
    super(mensaje);
  }
}

/** Sin respuesta del servidor (sin red o servidor caído). */
export class SinRed extends Error {}

type Escucha = (e: ErrorApi) => void;
const escuchas: Escucha[] = [];
/** La aplicación se entera de sesión vencida o aviso pendiente para redirigir. */
export const alErrorDeSesion = (f: Escucha) => escuchas.push(f);

export async function api<T = unknown>(metodo: 'GET' | 'POST' | 'PUT' | 'DELETE', ruta: string, cuerpo?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api${ruta}`, {
      method: metodo,
      credentials: 'same-origin',
      headers: { ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json', 'X-Dispositivo': idDispositivo() },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });
  } catch {
    throw new SinRed('Sin conexión con el servidor.');
  }
  const datos = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) {
    const e = new ErrorApi(r.status, datos?.codigo ?? 'error', datos?.mensaje ?? `Error ${r.status}`, datos ?? {});
    if (e.codigo === 'sin_sesion' || e.codigo === 'aviso_pendiente') escuchas.forEach((f) => f(e));
    throw e;
  }
  return datos as T;
}

export const urlApi = (ruta: string) => `/api${ruta}`;
