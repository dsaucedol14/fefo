/**
 * Recepción (CU-01): RF-01 ID único con dígito verificador, RF-02 varios lotes por tarima (RN-06),
 * RF-04 con RN-03 (vida remanente; bajo el mínimo autoriza un supervisor). La tarima queda «por ubicar».
 * El saldo entra por movimientos de recepción que aplica el disparador (ADR-006); RN-05 impide mezclar frío y
 * ambiente en la misma tarima.
 */
import { randomUUID } from 'node:crypto';
import { hoy, q, tx, uno } from '../../bd.js';
import { ErrorNegocio, traducir } from '../../errores.js';
import { idTarima } from '../ids.js';
import { evaluarRecepcion } from '../fefo/motor.js';
import { demandaMedia } from '../../repositorios/inventario.js';
import { verificarSupervisor, type Usuario } from '../../seguridad/sesion.js';

export interface LoteRecibido { sku: string; num_lote: string; fecha_caducidad: string; cajas: number }
export interface Autorizacion { propia?: boolean; usuario?: string; contrasena?: string }

export async function recibir(p: { lotes: LoteRecibido[]; autorizacion?: Autorizacion; id_dispositivo?: string; tarea?: string; escaneos?: number },
  usuario: Usuario) {
  const fecha = await hoy();
  const vistos = new Set<string>();
  const avisos: Array<{ sku: string; num_lote: string; dias: number; minimo: number }> = [];
  for (const l of p.lotes) {
    l.num_lote = l.num_lote.trim().toUpperCase();
    const clave = `${l.sku}|${l.num_lote}|${l.fecha_caducidad}`;
    if (vistos.has(clave)) throw new ErrorNegocio('lote_repetido', `El lote ${l.num_lote} está repetido; súmalo en un solo renglón.`);
    vistos.add(clave);
    const prod = await uno<{ vmr_dias: number; tr_dias: number }>(
      `SELECT c.vmr_dias, c.tr_dias FROM producto p JOIN categoria c USING (id_categoria) WHERE p.sku = $1 AND p.activo`, [l.sku]);
    if (!prod) throw new ErrorNegocio('producto_inexistente', `El producto ${l.sku} no existe o está inactivo.`, 404);
    const ev = evaluarRecepcion({ caducidad: l.fecha_caducidad, hoy: fecha, cajas: l.cajas, demanda: await demandaMedia(l.sku), vmr: prod.vmr_dias, tr: prod.tr_dias });
    if (ev.estado === 'rechazar') throw new ErrorNegocio('caducado', `El lote ${l.num_lote} ya caducó; no se puede recibir.`);
    if (ev.estado === 'autorizar') avisos.push({ sku: l.sku, num_lote: l.num_lote, dias: ev.dias, minimo: ev.minimo });
  }

  let autorizo: string | null = null;
  if (avisos.length) {
    const a = p.autorizacion;
    if (a?.propia && (usuario.rol === 'supervisor' || usuario.rol === 'administracion')) autorizo = usuario.id_usuario;
    else if (a?.usuario && a.contrasena) autorizo = await verificarSupervisor(a.usuario.toLowerCase(), a.contrasena);
    else throw new ErrorNegocio('requiere_autorizacion', 'Hay lotes con vida remanente por debajo del mínimo (RN-03): autoriza un supervisor.', 409, { avisos });
  }
  const conAviso = new Set(avisos.map((a) => `${a.sku}|${a.num_lote}`));

  try {
    return await tx(usuario.id_usuario, async (con) => {
      const [{ serie }] = await q<{ serie: number }>(`SELECT nextval('seq_tarima')::int AS serie`, [], con);
      const [{ prefijo }] = await q<{ prefijo: number }>(`SELECT COALESCE((SELECT valor FROM parametro WHERE clave = 'prefijo_gs1'), 0) AS prefijo`, [], con);
      const id = idTarima(prefijo, serie);
      await q(`INSERT INTO tarima (id_tarima) VALUES ($1)`, [id], con);
      const lotes = [];
      for (const l of p.lotes) {
        let lote = await uno<{ id_lote: string }>(
          `SELECT id_lote FROM lote WHERE sku = $1 AND num_lote = $2 AND fecha_caducidad = $3`, [l.sku, l.num_lote, l.fecha_caducidad], con);
        if (!lote) {
          lote = await uno<{ id_lote: string }>(
            `INSERT INTO lote (sku, num_lote, fecha_caducidad, fecha_recepcion, autorizado_por) VALUES ($1, $2, $3, $4, $5) RETURNING id_lote`,
            [l.sku, l.num_lote, l.fecha_caducidad, fecha, conAviso.has(`${l.sku}|${l.num_lote}`) ? autorizo : null], con);
        }
        await q(`INSERT INTO movimiento (id_mov, tipo, id_tarima, id_lote, delta_cajas, id_usuario, id_dispositivo, fecha_dispositivo, tarea, escaneos)
                 VALUES ($1, 'recepcion', $2, $3, $4, $5, $6, now(), $7, $8)`,
          [randomUUID(), id, lote!.id_lote, l.cajas, usuario.id_usuario, p.id_dispositivo ?? null, p.tarea ?? null, p.escaneos ?? null], con);
        lotes.push({ ...l, id_lote: lote!.id_lote });
      }
      return { id_tarima: id, estado: 'por_ubicar', lotes, autorizado_por: autorizo };
    });
  } catch (e) {
    throw traducir(e) ?? e;
  }
}
