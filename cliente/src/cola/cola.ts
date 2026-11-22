/**
 * Cola local de movimientos y sincronizador (RNF-03 nivel 1, ADR-004, Fig. 8 de P3).
 * Cada escaneo que cambia el estado se guarda en IndexedDB con su id_mov (UUID) y la hora del dispositivo, y se
 * envía en orden. El servidor responde por movimiento: aplicado o duplicado → se borra; rechazado → queda visible
 * para el operador y la base lo deja para revisión del supervisor. Sin red, nada se pierde ni se duplica.
 * También guarda instantáneas (posición de cada tarima, listas de surtido) para operar sin red.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { api, SinRed, ErrorApi } from '../api.js';

export interface Movimiento {
  id_mov: string;
  tipo: 'ubicacion' | 'reubicacion' | 'salida';
  id_tarima: string;
  id_lote?: string | null;
  cajas?: number;
  pos_origen?: string | null;
  pos_destino?: string | null;
  motivo_excepcion?: string | null;
  justificacion?: string | null;
  id_pedido?: string | null;
  renglon?: number | null;
  id_reserva?: number | null;
  id_lote_propuesto?: string | null;
  fecha_dispositivo: string;
  tarea?: string | null;
  escaneos?: number | null;
}
export interface EnCola { id_mov: string; mov: Movimiento; estado: 'pendiente' | 'rechazado'; creado: number; diferido: boolean; codigo?: string; mensaje?: string }
export interface Resultado { id_mov: string; estado: 'aplicado' | 'duplicado' | 'rechazado' | 'pendiente'; codigo?: string; mensaje?: string; es_fefo?: boolean | null }

let bd: Promise<IDBPDatabase> | null = null;
function base() {
  bd ??= openDB('fefo', 1, {
    upgrade(db) {
      db.createObjectStore('cola', { keyPath: 'id_mov' }).createIndex('creado', 'creado');
      db.createObjectStore('cache');
    },
  });
  return bd;
}

type Escucha = () => void;
const escuchas = new Set<Escucha>();
/** La barra muestra el número de pendientes (Fig. 11c). */
export const alCambiar = (f: Escucha) => { escuchas.add(f); return () => escuchas.delete(f); };
const avisar = () => escuchas.forEach((f) => f());

export async function enCola(): Promise<EnCola[]> {
  return (await base()).getAllFromIndex('cola', 'creado') as Promise<EnCola[]>;
}

export async function descartar(idMov: string) {
  await (await base()).delete('cola', idMov);
  avisar();
}

let enCurso: Promise<Map<string, Resultado>> | null = null;

/** Envía los pendientes en orden de captura. Devuelve el resultado por id_mov de lo que se envió. */
export function sincronizar(): Promise<Map<string, Resultado>> {
  enCurso ??= (async () => {
    const res = new Map<string, Resultado>();
    try {
      const pendientes = (await enCola()).filter((x) => x.estado === 'pendiente');
      for (let i = 0; i < pendientes.length; i += 100) {
        const tramo = pendientes.slice(i, i + 100);
        const r = await api<{ resultados: Resultado[] }>('POST', '/movimientos', {
          movimientos: tramo.map((x) => x.mov), diferido: tramo.some((x) => x.diferido),
        });
        const db = await base();
        for (const x of r.resultados) {
          res.set(x.id_mov, x);
          if (x.estado === 'rechazado') {
            const item = tramo.find((t) => t.id_mov === x.id_mov)!;
            await db.put('cola', { ...item, estado: 'rechazado', codigo: x.codigo, mensaje: x.mensaje });
          } else {
            await db.delete('cola', x.id_mov);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof SinRed) && !(e instanceof ErrorApi && e.estado === 401)) throw e;
    } finally {
      enCurso = null;
      avisar();
    }
    return res;
  })();
  return enCurso;
}

/**
 * Guarda el movimiento y, si hay red, lo envía de inmediato. Si la base lo rechaza en línea (p. ej. requiere
 * motivo), se quita de la cola y se devuelve el rechazo para que el operador lo resuelva en la misma pantalla.
 */
export async function registrar(mov: Movimiento): Promise<Resultado> {
  const db = await base();
  await db.put('cola', { id_mov: mov.id_mov, mov, estado: 'pendiente', creado: Date.now(), diferido: !navigator.onLine } satisfies EnCola);
  avisar();
  let res = await sincronizar();
  // Si ya había un envío en curso, este movimiento entra en la siguiente vuelta
  if (!res.has(mov.id_mov) && navigator.onLine) res = await sincronizar();
  const r = res.get(mov.id_mov);
  if (!r) return { id_mov: mov.id_mov, estado: 'pendiente' };
  if (r.estado === 'rechazado') await descartar(mov.id_mov);
  return r;
}

export async function guardarCache(clave: string, valor: unknown) {
  await (await base()).put('cache', valor, clave);
}
export async function leerCache<T>(clave: string): Promise<T | undefined> {
  return (await base()).get('cache', clave) as Promise<T | undefined>;
}

/** Instantánea de la posición de cada tarima: el origen de una reubicación sin red (contrato de sincronización). */
export async function refrescarPosiciones() {
  try {
    const filas = await api<Array<{ id_tarima: string; id_posicion: string | null; estado: string }>>('GET', '/tarimas');
    await guardarCache('posiciones', Object.fromEntries(filas.map((f) => [f.id_tarima, f])));
  } catch { /* sin red: se conserva la anterior */ }
}

export async function posicionConocida(idTarima: string) {
  const p = await leerCache<Record<string, { id_posicion: string | null; estado: string }>>('posiciones');
  return p?.[idTarima];
}

export async function anotarPosicion(idTarima: string, idPosicion: string | null, estadoTarima: string) {
  const p = (await leerCache<Record<string, unknown>>('posiciones')) ?? {};
  p[idTarima] = { id_tarima: idTarima, id_posicion: idPosicion, estado: estadoTarima };
  await guardarCache('posiciones', p);
}

/** Sincroniza al recuperar la señal, al volver la aplicación a primer plano y cada 30 s (Fig. 8). */
export function iniciarSincronizador() {
  window.addEventListener('online', () => { void sincronizar(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sincronizar(); });
  setInterval(() => { if (navigator.onLine) void sincronizar(); }, 30_000);
}
