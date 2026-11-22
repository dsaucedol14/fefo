/**
 * PE-09 (lado del cliente): 30 movimientos capturados sin red se guardan en IndexedDB y se sincronizan sin perder
 * ni duplicar ninguno, aunque se pierda la respuesta del servidor a mitad del envío (reenvío idempotente).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

let enLinea = false;
Object.defineProperty(globalThis, 'navigator', { value: { get onLine() { return enLinea; } }, configurable: true });

// Servidor simulado: aplica cada id_mov una sola vez, como el disparador de P3 (PI-16)
const aplicados = new Set<string>();
let perderRespuesta = false;
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  if (!enLinea) throw new TypeError('Failed to fetch');
  const cuerpo = JSON.parse(String(init.body)) as { movimientos: Array<{ id_mov: string }> };
  const resultados = cuerpo.movimientos.map((m) => {
    const dup = aplicados.has(m.id_mov);
    aplicados.add(m.id_mov);
    return { id_mov: m.id_mov, estado: dup ? 'duplicado' : 'aplicado' };
  });
  if (perderRespuesta) { perderRespuesta = false; throw new TypeError('Failed to fetch'); }
  return new Response(JSON.stringify({ resultados }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { registrar, sincronizar, enCola } = await import('./cola.js');

const mov = (i: number) => ({ id_mov: crypto.randomUUID(), tipo: 'reubicacion' as const, id_tarima: String(i).padStart(18, '0'),
  pos_origen: 'C-R01-N1', pos_destino: 'C-R01-N2', fecha_dispositivo: new Date().toISOString() });

describe('cola sin red (RNF-03 nivel 1)', () => {
  beforeEach(() => { aplicados.clear(); });

  it('guarda 30 movimientos sin red y los aplica una sola vez al recuperarla, aun si se pierde una respuesta', async () => {
    enLinea = false;
    for (let i = 0; i < 30; i++) expect((await registrar(mov(i))).estado).toBe('pendiente');
    expect((await enCola()).filter((x) => x.estado === 'pendiente')).toHaveLength(30);
    expect((await enCola()).every((x) => x.diferido)).toBe(true);

    enLinea = true;
    perderRespuesta = true;              // el servidor aplica pero la respuesta no llega
    await sincronizar();
    expect(aplicados.size).toBe(30);
    expect(await enCola()).toHaveLength(30);   // el teléfono no sabe que se aplicaron: siguen pendientes

    const r = await sincronizar();             // reenvío: todo llega como duplicado y se borra de la cola
    expect([...r.values()].every((x) => x.estado === 'duplicado')).toBe(true);
    expect(await enCola()).toHaveLength(0);
    expect(aplicados.size).toBe(30);           // 0 perdidos, 0 duplicados
  });
});
