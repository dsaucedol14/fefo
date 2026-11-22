-- =====================================================================
-- Extensión del prototipo sobre el modelo físico de P3 (ADR-010)
-- Se ejecuta después de 01_esquema.sql y 02_catalogo.sql. No modifica ninguna tabla, regla ni
-- disparador de P3: solo agrega lo que el prototipo necesita y P3 no especifica.
--   1. Reservas parciales por renglón (CF2): un renglón puede repartirse entre varios lotes y tarimas.
--   2. Evidencia de evaluación en cada movimiento (OD7, P2 III.F, mitigación de R6): lote propuesto,
--      tarea, escaneos, justificación y reserva.
--   3. Eventos que no cambian estado (búsquedas, sesiones, tareas), de solo inserción.
--   4. Sesiones de usuario y aviso de privacidad (RNF-08, RNF-09).
--   5. Serie de identificadores de tarima (RF-01, ADR-007).
-- =====================================================================
SET search_path = fefo;

-- ---------- 1. Reservas (CF2) ----------
CREATE TYPE estado_reserva AS ENUM ('abierta', 'surtida', 'liberada');
CREATE TABLE reserva (
    id_reserva BIGSERIAL PRIMARY KEY,
    id_pedido  VARCHAR(20) NOT NULL,
    renglon    SMALLINT NOT NULL,
    id_lote    UUID NOT NULL REFERENCES lote,
    id_tarima  CHAR(18) NOT NULL REFERENCES tarima,
    cajas      INTEGER NOT NULL CHECK (cajas > 0),
    estado     estado_reserva NOT NULL DEFAULT 'abierta',
    creada     TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (id_pedido, renglon) REFERENCES linea_pedido
);
CREATE INDEX ix_reserva_abierta ON reserva (id_tarima, id_lote) WHERE estado = 'abierta';
-- Un pedido cancelado libera sus reservas; P3 no define estado del pedido (se deriva de sus salidas)
ALTER TABLE pedido ADD COLUMN cancelado_en TIMESTAMPTZ;
CREATE INDEX ix_reserva_linea ON reserva (id_pedido, renglon);

-- ---------- 2. Evidencia de evaluación en el movimiento ----------
ALTER TABLE movimiento
    ADD COLUMN id_lote_propuesto UUID REFERENCES lote,          -- R6: lo que el sistema recomendó al operador
    ADD COLUMN tarea             VARCHAR(30),                   -- código de la tarea de evaluación (P2 III.F)
    ADD COLUMN escaneos          SMALLINT CHECK (escaneos >= 0),
    ADD COLUMN justificacion     VARCHAR(300),                  -- obligatoria en la API si el motivo es decisión del operador
    ADD COLUMN id_reserva        BIGINT REFERENCES reserva;

-- Una salida ligada a una reserva la cierra en la misma transacción (el estado cambia por movimientos, ADR-006).
-- Si el lote o la tarima no son los reservados, la reserva se libera y el servicio de surtido vuelve a asignar.
CREATE FUNCTION tg_cierra_reserva() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.tipo = 'salida' AND NEW.id_reserva IS NOT NULL THEN
        UPDATE reserva r
           SET estado = CASE WHEN r.id_lote = NEW.id_lote AND r.id_tarima = NEW.id_tarima THEN 'surtida' ELSE 'liberada' END::estado_reserva
         WHERE r.id_reserva = NEW.id_reserva AND r.estado = 'abierta';
    END IF;
    -- Una tarima vacía ya no puede surtir: se liberan sus reservas abiertas
    IF NEW.tipo IN ('salida', 'baja', 'ajuste')
       AND EXISTS (SELECT 1 FROM tarima WHERE id_tarima = NEW.id_tarima AND estado = 'vacia') THEN
        UPDATE reserva SET estado = 'liberada' WHERE id_tarima = NEW.id_tarima AND estado = 'abierta';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tr_cierra_reserva AFTER INSERT ON movimiento FOR EACH ROW EXECUTE FUNCTION tg_cierra_reserva();

-- ---------- 3. Eventos sin cambio de estado (solo inserción) ----------
CREATE TABLE evento (
    id                BIGSERIAL PRIMARY KEY,
    tipo              VARCHAR(30) NOT NULL,          -- sesion, busqueda, tarea_inicio, tarea_fin, rechazo_sync…
    id_usuario        VARCHAR(20) REFERENCES usuario,
    id_dispositivo    UUID REFERENCES dispositivo,
    tarea             VARCHAR(30),
    escaneos          SMALLINT CHECK (escaneos >= 0),
    resultado         VARCHAR(30),
    detalle           JSONB,
    fecha_dispositivo TIMESTAMPTZ,
    fecha_servidor    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_evento_tarea ON evento (tarea) WHERE tarea IS NOT NULL;
CREATE TRIGGER tr_evento_inmutable BEFORE UPDATE OR DELETE ON evento FOR EACH ROW EXECUTE FUNCTION tg_solo_insercion();

-- Los cambios de umbrales también dejan valor anterior y nuevo (RNF-11)
CREATE TRIGGER tr_bit_categoria AFTER INSERT OR UPDATE OR DELETE ON categoria FOR EACH ROW EXECUTE FUNCTION tg_bitacora();

-- Corrección de seguridad (ADR-010): tg_bitacora de P3 copiaba la fila completa de usuario, incluido el hash
-- de la contraseña, a una tabla que no se puede borrar. Se registra el mismo cambio sin el hash.
DROP TRIGGER tr_bit_usuario ON usuario;
CREATE FUNCTION tg_bitacora_usuario() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO bitacora (entidad, operacion, valor_anterior, valor_nuevo, id_usuario)
    VALUES (TG_TABLE_NAME, left(TG_OP, 1),
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'hash_contrasena' END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'hash_contrasena' END,
            current_setting('app.usuario', true));
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bit_usuario AFTER INSERT OR UPDATE OR DELETE ON usuario FOR EACH ROW EXECUTE FUNCTION tg_bitacora_usuario();

-- ---------- 4. Sesiones y privacidad ----------
CREATE TABLE sesion (
    id_sesion        CHAR(64) PRIMARY KEY,          -- SHA-256 del token; el token solo viaja en la cookie
    id_usuario       VARCHAR(20) NOT NULL REFERENCES usuario,
    creada           TIMESTAMPTZ NOT NULL DEFAULT now(),
    ultima_actividad TIMESTAMPTZ NOT NULL DEFAULT now(),
    expira           TIMESTAMPTZ NOT NULL
);
ALTER TABLE usuario ADD COLUMN aviso_aceptado_en TIMESTAMPTZ;   -- RNF-09

-- ---------- 5. Identificadores de tarima ----------
CREATE SEQUENCE seq_tarima START 1;
INSERT INTO parametro (clave, valor, descripcion) VALUES
    ('prefijo_gs1', 750123, 'ADR-007: prefijo de empresa (7 dígitos) en el ID de tarima de 18 dígitos')
ON CONFLICT (clave) DO NOTHING;

-- ---------- Permisos del rol de la aplicación ----------
GRANT SELECT, INSERT, UPDATE ON reserva TO app_fefo;
GRANT SELECT, INSERT ON evento TO app_fefo;
GRANT SELECT, INSERT, UPDATE, DELETE ON sesion TO app_fefo;
GRANT SELECT, UPDATE ON usuario TO app_fefo;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA fefo TO app_fefo;
REVOKE UPDATE, DELETE ON movimiento, bitacora, evento FROM app_fefo;
