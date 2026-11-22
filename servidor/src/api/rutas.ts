/**
 * Interfaz REST del servidor (P3, Tabla XI), JSON sobre HTTPS bajo /api. Cada ruta valida su entrada con
 * esquema JSON (Fastify) y exige sesión y rol; los errores de la base llegan traducidos (errores.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { autenticar, autorizar, cerrarSesion, COOKIE, iniciarSesion, opcionesCookie, type Rol } from '../seguridad/sesion.js';
import { q } from '../bd.js';
import { recibir } from '../dominio/recepcion/servicio.js';
import * as ubic from '../dominio/ubicaciones/servicio.js';
import { registrar, type MovimientoEntrada } from '../dominio/movimientos/servicio.js';
import * as surtido from '../dominio/surtido/servicio.js';
import { alertas, proponerBaja } from '../dominio/alertas/servicio.js';
import * as par from '../dominio/parametros/servicio.js';
import * as ev from '../dominio/evaluacion/servicio.js';
import { etiquetaTarima, etiquetasPosiciones } from '../dominio/etiquetas/pdf.js';
import { config } from '../config.js';

const uuid = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } as const;
const tarimaId = { type: 'string', pattern: '^[0-9]{18}$' } as const;
const posicionId = { type: 'string', maxLength: 16, pattern: '^[A-Z]-[A-Z0-9-]+$' } as const;
const fecha = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const motivos = ['dato_caducidad_erroneo', 'movimiento_no_registrado', 'tarima_inaccesible', 'decision_operador', 'producto_danado', 'lote_pedido_cliente'];

const dispositivo = (req: FastifyRequest) => {
  const d = req.headers['x-dispositivo'];
  return typeof d === 'string' && /^[0-9a-f-]{36}$/i.test(d) ? d : null;
};

export async function rutas(app: FastifyInstance) {
  // ---------- Sesión (RNF-08) ----------
  app.post('/api/sesiones', {
    schema: { body: { type: 'object', required: ['usuario', 'contrasena'], additionalProperties: false, properties: {
      usuario: { type: 'string', minLength: 1, maxLength: 20 }, contrasena: { type: 'string', minLength: 1, maxLength: 200 },
      id_dispositivo: uuid, descripcion_dispositivo: { type: 'string', maxLength: 60 } } } },
  }, async (req, rep) => {
    const b = req.body as { usuario: string; contrasena: string; id_dispositivo?: string; descripcion_dispositivo?: string };
    const { token, usuario } = await iniciarSesion(b.usuario.trim().toLowerCase(), b.contrasena);
    if (b.id_dispositivo) {
      await q(`INSERT INTO dispositivo (id_dispositivo, id_usuario, descripcion) VALUES ($1, $2, $3)
               ON CONFLICT (id_dispositivo) DO UPDATE SET id_usuario = EXCLUDED.id_usuario, descripcion = COALESCE(EXCLUDED.descripcion, dispositivo.descripcion)`,
        [b.id_dispositivo, usuario.id_usuario, b.descripcion_dispositivo?.slice(0, 60) ?? null]);
    }
    await ev.registrarEvento({ tipo: 'sesion', resultado: 'inicio' }, usuario, b.id_dispositivo ?? null);
    rep.setCookie(COOKIE, token, opcionesCookie());
    return usuario;
  });

  app.register(async (api) => {
    api.addHook('preHandler', autenticar);
    const rol = (r: Rol) => ({ preHandler: autorizar(r) });

    api.get('/api/sesiones/actual', async (req) => req.usuario);
    api.delete('/api/sesiones', async (req, rep) => {
      await cerrarSesion(req.cookies[COOKIE]);
      rep.clearCookie(COOKIE, { path: '/' });
      return { ok: true };
    });
    api.post('/api/aviso', async (req) => {
      await q(`UPDATE usuario SET aviso_aceptado_en = now() WHERE id_usuario = $1 AND aviso_aceptado_en IS NULL`, [req.usuario!.id_usuario]);
      return { ok: true };
    });

    // ---------- Catálogo ----------
    api.get('/api/productos', { schema: { querystring: { type: 'object', properties: { gtin: { type: 'string', pattern: '^\\d{8,14}$' } } } } },
      async (req) => par.productos((req.query as { gtin?: string }).gtin));

    // ---------- Recepción (RF-01, 02, 04) ----------
    api.post('/api/recepciones', {
      schema: { body: { type: 'object', required: ['lotes'], additionalProperties: false, properties: {
        lotes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['sku', 'num_lote', 'fecha_caducidad', 'cajas'], additionalProperties: false,
          properties: { sku: { type: 'string', maxLength: 14 }, num_lote: { type: 'string', minLength: 1, maxLength: 20 }, fecha_caducidad: fecha,
            cajas: { type: 'integer', minimum: 1, maximum: 9999 } } } },
        autorizacion: { type: 'object', additionalProperties: false, properties: { propia: { type: 'boolean' }, usuario: { type: 'string', maxLength: 20 }, contrasena: { type: 'string', maxLength: 200 } } },
        tarea: { type: 'string', maxLength: 30 }, escaneos: { type: 'integer', minimum: 0, maximum: 999 } } } },
    }, async (req) => recibir({ ...(req.body as Parameters<typeof recibir>[0]), id_dispositivo: dispositivo(req) ?? undefined }, req.usuario!));

    api.get('/api/etiquetas/tarimas/:id', { schema: { params: { type: 'object', properties: { id: tarimaId } } } }, async (req, rep) => {
      const t = await ubic.tarima((req.params as { id: string }).id);
      rep.type('application/pdf').header('Content-Disposition', `inline; filename="tarima-${t.id_tarima}.pdf"`);
      return etiquetaTarima(t as never);
    });
    api.get('/api/etiquetas/posiciones', { ...rol('supervisor'), schema: { querystring: { type: 'object', properties: { zona: { type: 'string', pattern: '^[A-Z]$' } } } } }, async (req, rep) => {
      const zona = (req.query as { zona?: string }).zona;
      const pos = await q<{ id_posicion: string; tipo: string; profundidad: number }>(
        `SELECT p.id_posicion, z.tipo, p.profundidad FROM posicion p JOIN zona z USING (id_zona) WHERE p.activa AND ($1::text IS NULL OR z.codigo = $1) ORDER BY p.id_posicion`, [zona ?? null]);
      rep.type('application/pdf').header('Content-Disposition', `inline; filename="posiciones${zona ? '-' + zona : ''}.pdf"`);
      return etiquetasPosiciones(pos);
    });

    // ---------- Ubicaciones (RF-05, 07, 09) ----------
    api.get('/api/tarimas/:id', { schema: { params: { type: 'object', properties: { id: tarimaId } } } }, async (req) => ubic.tarima((req.params as { id: string }).id));
    api.get('/api/tarimas', async () => ubic.posiciones());
    api.get('/api/posiciones/sugerencia', { schema: { querystring: { type: 'object', required: ['tarima'], properties: { tarima: tarimaId } } } },
      async (req) => ubic.sugerir((req.query as { tarima: string }).tarima));
    api.get('/api/mapa', async () => ubic.mapa());
    api.get('/api/buscar', { schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 100 }, gtin: { type: 'string', pattern: '^\\d{8,14}$' },
      lote: { type: 'string', maxLength: 20 }, tarea: { type: 'string', maxLength: 30 }, escaneos: { type: 'integer', minimum: 0, maximum: 999 } } } } }, async (req) => {
      const p = req.query as { q?: string; gtin?: string; lote?: string; tarea?: string; escaneos?: number };
      const r = await ubic.buscar(p);
      // Evidencia de IND-1: cada búsqueda queda ligada a la tarea de evaluación (P2 III.F.3 b)
      await ev.registrarEvento({ tipo: 'busqueda', tarea: p.tarea ?? null, escaneos: p.escaneos ?? null,
        resultado: r.tipo === 'tarima' ? 'tarima' : `${r.resultados.length}`, detalle: { q: p.q ?? null, gtin: p.gtin ?? null, lote: p.lote ?? null } },
      req.usuario!, dispositivo(req));
      return r;
    });

    // ---------- Movimientos (RF-06, 08, 12, 13; RNF-03) ----------
    api.post('/api/movimientos', {
      schema: { body: { type: 'object', required: ['movimientos'], additionalProperties: false, properties: {
        diferido: { type: 'boolean' },
        movimientos: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['id_mov', 'tipo', 'id_tarima', 'fecha_dispositivo'], additionalProperties: false,
          properties: {
            id_mov: uuid, tipo: { enum: ['ubicacion', 'reubicacion', 'salida'] }, id_tarima: tarimaId, id_lote: { ...uuid, nullable: true },
            cajas: { type: 'integer', minimum: 1, maximum: 9999 }, pos_origen: { ...posicionId, nullable: true }, pos_destino: { ...posicionId, nullable: true },
            motivo_excepcion: { enum: [...motivos, null] }, justificacion: { type: 'string', maxLength: 300, nullable: true },
            id_pedido: { type: 'string', maxLength: 20, nullable: true }, renglon: { type: 'integer', minimum: 1, nullable: true },
            id_reserva: { type: 'integer', minimum: 1, nullable: true }, id_lote_propuesto: { ...uuid, nullable: true },
            fecha_dispositivo: { type: 'string', format: 'date-time' }, tarea: { type: 'string', maxLength: 30, nullable: true },
            escaneos: { type: 'integer', minimum: 0, maximum: 999, nullable: true } } } } } } },
    }, async (req) => {
      const b = req.body as { movimientos: MovimientoEntrada[]; diferido?: boolean };
      return { resultados: await registrar(b.movimientos, req.usuario!, dispositivo(req), b.diferido === true) };
    });

    // ---------- Pedidos y surtido (RF-11) ----------
    api.get('/api/pedidos', async () => surtido.pedidos());
    api.post('/api/pedidos', { ...rol('supervisor'), schema: { body: { type: 'object', required: ['lineas'], additionalProperties: false, properties: {
      cliente_ref: { type: 'string', maxLength: 40 },
      lineas: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['sku', 'cajas'], additionalProperties: false,
        properties: { sku: { type: 'string', maxLength: 14 }, cajas: { type: 'integer', minimum: 1, maximum: 9999 } } } } } } } },
    async (req) => surtido.crearPedido(req.body as Parameters<typeof surtido.crearPedido>[0], req.usuario!));
    api.post('/api/listas-surtido', { schema: { body: { type: 'object', required: ['id_pedido'], properties: { id_pedido: { type: 'string', maxLength: 20 } } } } },
      async (req) => {
        const id = (req.body as { id_pedido: string }).id_pedido;
        await surtido.generarLista(id, req.usuario!);
        return surtido.lista(id);
      });
    api.post('/api/pedidos/:id/cancelacion', rol('supervisor'), async (req) => {
      await surtido.cancelar((req.params as { id: string }).id, req.usuario!);
      return { ok: true };
    });

    // ---------- Alertas y bajas (RF-14, RF-16) ----------
    api.get('/api/alertas', rol('supervisor'), async () => alertas());
    api.post('/api/bajas', { schema: { body: { type: 'object', required: ['id_lote', 'id_tarima', 'motivo'], additionalProperties: false, properties: {
      id_lote: uuid, id_tarima: tarimaId, motivo: { enum: ['caducidad', 'cadena_frio', 'danio', 'otro'] } } } } },
    async (req) => proponerBaja(req.body as Parameters<typeof proponerBaja>[0], req.usuario!));

    // ---------- Parámetros y usuarios (RNF-11, RF-21) ----------
    api.get('/api/categorias', async () => par.categorias());
    const dias = { type: 'integer', minimum: 0, maximum: 3650 };
    api.put('/api/categorias/:id', { ...rol('supervisor'), schema: { params: { type: 'object', properties: { id: { type: 'integer' } } },
      body: { type: 'object', required: ['vu_dias', 'vmr_dias', 'tr_dias', 'ms_dias'], additionalProperties: false,
        properties: { vu_dias: { ...dias, minimum: 1 }, vmr_dias: dias, tr_dias: dias, ms_dias: dias } } } },
    async (req) => par.actualizarCategoria((req.params as { id: number }).id, req.body as never, req.usuario!));
    api.get('/api/parametros', rol('supervisor'), async () => par.parametros());
    api.put('/api/parametros/:clave', { ...rol('supervisor'), schema: { body: { type: 'object', required: ['valor'], properties: { valor: { type: 'number' } } } } },
      async (req) => par.actualizarParametro((req.params as { clave: string }).clave, (req.body as { valor: number }).valor, req.usuario!));
    api.get('/api/usuarios', rol('administracion'), async () => par.usuarios());
    api.post('/api/usuarios', { ...rol('administracion'), schema: { body: { type: 'object', required: ['id_usuario', 'nombre', 'rol', 'contrasena'], additionalProperties: false,
      properties: { id_usuario: { type: 'string', pattern: '^[a-z0-9._-]{3,20}$' }, nombre: { type: 'string', minLength: 1, maxLength: 80 },
        rol: { enum: ['almacenista', 'supervisor', 'administracion'] }, contrasena: { type: 'string', minLength: 8, maxLength: 200 } } } } },
    async (req) => { await par.crearUsuario(req.body as never, req.usuario!); return { ok: true }; });
    api.put('/api/usuarios/:id', { ...rol('supervisor'), schema: { body: { type: 'object', additionalProperties: false, properties: {
      rol: { enum: ['almacenista', 'supervisor', 'administracion'] }, activo: { type: 'boolean' }, desbloquear: { type: 'boolean' },
      contrasena: { type: 'string', minLength: 8, maxLength: 200 } } } } }, async (req, rep) => {
      const b = req.body as { rol?: Rol; activo?: boolean; desbloquear?: boolean; contrasena?: string };
      // El supervisor solo desbloquea; cambiar roles, estado o contraseñas es de administración
      if (req.usuario!.rol !== 'administracion' && (b.rol || b.activo !== undefined || b.contrasena)) {
        return rep.code(403).send({ codigo: 'sin_permiso', mensaje: 'Solo administración cambia roles, estado o contraseñas.' });
      }
      await par.actualizarUsuario((req.params as { id: string }).id, b, req.usuario!);
      return { ok: true };
    });

    // ---------- Evaluación y exportes (OD7) ----------
    api.post('/api/eventos', { schema: { body: { type: 'object', required: ['tipo'], additionalProperties: false, properties: {
      tipo: { enum: ['tarea_inicio', 'tarea_fin', 'tarea_practica'] }, tarea: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,30}$' },
      fecha_dispositivo: { type: 'string', format: 'date-time' }, detalle: { type: 'object' } } } } },
    async (req) => { await ev.registrarEvento(req.body as never, req.usuario!, dispositivo(req)); return { ok: true }; });
    api.get('/api/evaluacion/tareas', rol('supervisor'), async () => ev.tareas());
    api.get('/api/evaluacion/rechazos', rol('supervisor'), async () => ev.rechazos());
    api.get('/api/exportes/:nombre', rol('supervisor'), async (req, rep) => {
      const nombre = (req.params as { nombre: string }).nombre.replace(/\.csv$/, '');
      const csv = await ev.exportar(nombre);
      if (csv === null) return rep.code(404).send({ codigo: 'no_encontrado', mensaje: 'Ese exporte no existe.' });
      rep.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${nombre}.csv"`);
      return csv;
    });
    api.get('/api/version', async () => ({ version: config.version }));
  });
}
