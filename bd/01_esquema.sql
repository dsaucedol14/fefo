-- =====================================================================
-- P3 · Modelo físico de datos del prototipo (PostgreSQL 16)
-- Sistema de trazabilidad de tarimas y lotes con reglas FEFO
-- UNISUR · Seminario de Análisis y Diseño de Sistemas · nov. 2026
--
-- Principio de diseño (ADR-006): el estado (posición de la tarima y saldo
-- de cada lote) solo cambia por medio de un MOVIMIENTO. Un disparador aplica
-- cada movimiento al estado dentro de la misma transacción, de modo que la
-- bitácora y el inventario no pueden divergir (pruebas I8-I10 de P2).
-- Las reglas de negocio críticas se imponen en la base de datos, no solo en
-- la aplicación: RN-02, RN-04, RN-05, RN-08, RN-09 / RF-12, RF-20, RNF-07.
-- =====================================================================
DROP SCHEMA IF EXISTS fefo CASCADE;
CREATE SCHEMA fefo;
SET search_path = fefo;

-- ---------- Dominios y tipos ----------
CREATE TYPE tipo_zona       AS ENUM ('rack', 'piso', 'camara');
CREATE TYPE conservacion    AS ENUM ('ambiente', 'refrigerado', 'congelado');
CREATE TYPE estado_lote     AS ENUM ('disponible', 'retenido', 'baja');
CREATE TYPE estado_tarima   AS ENUM ('por_ubicar', 'ubicada', 'vacia');
CREATE TYPE tipo_mov        AS ENUM ('recepcion', 'ubicacion', 'reubicacion', 'salida', 'baja', 'ajuste');
CREATE TYPE motivo_fefo     AS ENUM ('dato_caducidad_erroneo', 'movimiento_no_registrado', 'tarima_inaccesible',
                                     'decision_operador', 'producto_danado', 'lote_pedido_cliente');   -- RN-09
CREATE TYPE motivo_baja     AS ENUM ('caducidad', 'cadena_frio', 'danio', 'otro');                    -- RF-17
CREATE TYPE causa_merma     AS ENUM ('omision_fefo', 'fuera_de_zona', 'rotacion');                    -- RF-19
CREATE TYPE estado_baja     AS ENUM ('pendiente', 'autorizada', 'rechazada');
CREATE TYPE rol_usuario     AS ENUM ('almacenista', 'supervisor', 'administracion');                   -- RF-21

-- ---------- Organización y espacio físico ----------
CREATE TABLE empresa (
    id_empresa  SMALLSERIAL PRIMARY KEY,
    nombre      VARCHAR(80) NOT NULL
);
CREATE TABLE almacen (
    id_almacen  SMALLSERIAL PRIMARY KEY,
    id_empresa  SMALLINT NOT NULL REFERENCES empresa,
    nombre      VARCHAR(80) NOT NULL
);
CREATE TABLE zona (
    id_zona     SMALLSERIAL PRIMARY KEY,
    id_almacen  SMALLINT NOT NULL REFERENCES almacen,
    codigo      CHAR(1) NOT NULL,
    tipo        tipo_zona NOT NULL,
    es_fria     BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (id_almacen, codigo),
    CHECK (es_fria = (tipo = 'camara'))
);
CREATE TABLE posicion (                                                   -- RN-04
    id_posicion VARCHAR(16) PRIMARY KEY,
    id_zona     SMALLINT NOT NULL REFERENCES zona,
    fila        VARCHAR(8),               -- solo piso: agrupa las posiciones de una fila
    profundidad SMALLINT NOT NULL DEFAULT 1 CHECK (profundidad BETWEEN 1 AND 4),
    activa      BOOLEAN NOT NULL DEFAULT TRUE,
    CHECK (id_posicion ~ '^[A-Z]-P[0-9]{2}-R[0-9]{2}-N[0-9]$'      -- rack
        OR id_posicion ~ '^[A-Z]-F[0-9]{2}-D[1-4]$'               -- piso
        OR id_posicion ~ '^[A-Z]-R[0-9]{2}-N[0-9]$'),             -- cámara
    CHECK ((fila IS NULL) = (id_posicion !~ '-F[0-9]{2}-D'))
);

-- ---------- Catálogo ----------
CREATE TABLE categoria (                                                  -- RN-07, Sección VII.E de P2
    id_categoria SMALLSERIAL PRIMARY KEY,
    nombre       VARCHAR(40) NOT NULL UNIQUE,
    conservacion conservacion NOT NULL,
    vu_dias      SMALLINT NOT NULL CHECK (vu_dias > 0),   -- vida útil típica
    vmr_dias     SMALLINT NOT NULL CHECK (vmr_dias >= 0),  -- vida mínima remanente exigida por clientes
    tr_dias      SMALLINT NOT NULL CHECK (tr_dias >= 0),   -- tiempo para despachar o liquidar
    ms_dias      SMALLINT NOT NULL CHECK (ms_dias >= 0),   -- margen de seguridad
    umbral_dias  SMALLINT GENERATED ALWAYS AS (LEAST(vu_dias, vmr_dias + tr_dias + ms_dias)) STORED  -- U(c)
);
CREATE TABLE producto (
    sku            VARCHAR(14) PRIMARY KEY,                -- GTIN o código interno
    nombre         VARCHAR(80) NOT NULL,
    id_categoria   SMALLINT NOT NULL REFERENCES categoria,
    requiere_frio  BOOLEAN NOT NULL,
    vida_util_dias SMALLINT NOT NULL CHECK (vida_util_dias > 0),
    costo_caja     NUMERIC(10,2) NOT NULL CHECK (costo_caja >= 0),
    activo         BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- Usuarios y dispositivos ----------
CREATE TABLE usuario (                                                    -- RNF-08, RNF-09 (minimización)
    id_usuario        VARCHAR(20) PRIMARY KEY,
    nombre            VARCHAR(80) NOT NULL,
    rol               rol_usuario NOT NULL,
    hash_contrasena   TEXT NOT NULL,                       -- bcrypt; nunca texto plano
    intentos_fallidos SMALLINT NOT NULL DEFAULT 0 CHECK (intentos_fallidos >= 0),
    bloqueado         BOOLEAN GENERATED ALWAYS AS (intentos_fallidos >= 5) STORED,
    activo            BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE dispositivo (                                                -- RNF-03 (cola local)
    id_dispositivo UUID PRIMARY KEY,
    id_usuario     VARCHAR(20) NOT NULL REFERENCES usuario,
    descripcion    VARCHAR(60),
    ultima_sync    TIMESTAMPTZ
);

-- ---------- Inventario ----------
CREATE TABLE lote (                                                       -- RF-02, RN-03
    id_lote            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku                VARCHAR(14) NOT NULL REFERENCES producto,
    num_lote           VARCHAR(20) NOT NULL,                       -- GS1 AI 10
    fecha_caducidad    DATE NOT NULL,                              -- GS1 AI 17
    caducidad_efectiva DATE,                                       -- se registra si se rompe la cadena de frío
    fecha_recepcion    DATE NOT NULL,
    estado             estado_lote NOT NULL DEFAULT 'disponible',
    autorizado_por     VARCHAR(20) REFERENCES usuario,             -- RN-03: vida remanente insuficiente
    UNIQUE (sku, num_lote, fecha_caducidad),
    CHECK (fecha_caducidad >= fecha_recepcion),
    CHECK (caducidad_efectiva IS NULL OR caducidad_efectiva <= fecha_caducidad)
);
CREATE TABLE tarima (                                                     -- RF-01, RF-06
    id_tarima       CHAR(18) PRIMARY KEY CHECK (id_tarima ~ '^[0-9]{18}$'),
    id_posicion     VARCHAR(16) REFERENCES posicion,
    estado          estado_tarima NOT NULL DEFAULT 'por_ubicar',
    fecha_recepcion TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((estado = 'ubicada') = (id_posicion IS NOT NULL))
);
-- I1: una posición, a lo más una tarima (la lección del diccionario occ de P2)
CREATE UNIQUE INDEX ux_tarima_posicion ON tarima (id_posicion) WHERE id_posicion IS NOT NULL;

CREATE TABLE tarima_lote (                                                -- RN-06 (N:M)
    id_tarima CHAR(18) NOT NULL REFERENCES tarima,
    id_lote   UUID NOT NULL REFERENCES lote,
    cajas     INTEGER NOT NULL DEFAULT 0 CHECK (cajas >= 0),            -- I7 / RNF-07
    PRIMARY KEY (id_tarima, id_lote)
);

-- ---------- Pedidos ----------
CREATE TABLE pedido (                                                     -- RF-10
    id_pedido   VARCHAR(20) PRIMARY KEY,
    fecha       DATE NOT NULL,
    cliente_ref VARCHAR(40)
);
CREATE TABLE linea_pedido (
    id_pedido         VARCHAR(20) NOT NULL REFERENCES pedido,
    renglon           SMALLINT NOT NULL,
    sku               VARCHAR(14) NOT NULL REFERENCES producto,
    cajas             INTEGER NOT NULL CHECK (cajas > 0),
    id_lote_reservado UUID REFERENCES lote,                       -- CF2: reserva al generar la lista
    PRIMARY KEY (id_pedido, renglon)
);

-- ---------- Movimientos (bitácora operativa, solo inserción) ----------
CREATE TABLE movimiento (                                                 -- RF-06, 08, 12, 13, 20
    id_mov            UUID PRIMARY KEY,           -- lo genera el dispositivo: idempotencia al sincronizar
    tipo              tipo_mov NOT NULL,
    id_tarima         CHAR(18) NOT NULL REFERENCES tarima,
    id_lote           UUID REFERENCES lote,
    delta_cajas       INTEGER NOT NULL DEFAULT 0,
    pos_origen        VARCHAR(16) REFERENCES posicion,
    pos_destino       VARCHAR(16) REFERENCES posicion,
    es_fefo           BOOLEAN,                    -- lo calcula la base al insertar una salida
    motivo_excepcion  motivo_fefo,
    id_pedido         VARCHAR(20),
    renglon           SMALLINT,
    id_usuario        VARCHAR(20) NOT NULL REFERENCES usuario,
    id_dispositivo    UUID REFERENCES dispositivo,
    fecha_dispositivo TIMESTAMPTZ NOT NULL,
    fecha_servidor    TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (id_pedido, renglon) REFERENCES linea_pedido,
    CHECK (CASE tipo
        WHEN 'recepcion'   THEN delta_cajas > 0 AND id_lote IS NOT NULL
        WHEN 'ubicacion'   THEN delta_cajas = 0 AND pos_destino IS NOT NULL AND pos_origen IS NULL
        WHEN 'reubicacion' THEN delta_cajas = 0 AND pos_destino IS NOT NULL AND pos_origen IS NOT NULL AND pos_origen <> pos_destino
        WHEN 'salida'      THEN delta_cajas < 0 AND id_lote IS NOT NULL
        WHEN 'baja'        THEN delta_cajas < 0 AND id_lote IS NOT NULL
        WHEN 'ajuste'      THEN delta_cajas <> 0 AND id_lote IS NOT NULL
    END)
);
CREATE INDEX ix_mov_tarima ON movimiento (id_tarima, fecha_servidor);
CREATE INDEX ix_mov_lote   ON movimiento (id_lote) WHERE id_lote IS NOT NULL;

CREATE TABLE baja (                                                       -- RF-16, RF-17, RN-08
    id_baja        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_lote        UUID NOT NULL REFERENCES lote,
    id_tarima      CHAR(18) NOT NULL REFERENCES tarima,
    cajas          INTEGER NOT NULL CHECK (cajas > 0),
    motivo         motivo_baja NOT NULL,
    causa_derivada causa_merma,                -- la calcula el módulo de reportes (RF-19)
    estado         estado_baja NOT NULL DEFAULT 'pendiente',
    registrado_por VARCHAR(20) NOT NULL REFERENCES usuario,
    autorizado_por VARCHAR(20) REFERENCES usuario,
    id_mov         UUID REFERENCES movimiento,    -- movimiento que descontó las cajas
    CHECK (autorizado_por IS NULL OR autorizado_por <> registrado_por),    -- RN-08
    CHECK ((estado = 'autorizada') = (id_mov IS NOT NULL AND autorizado_por IS NOT NULL))
);

CREATE TABLE conteo (                                                     -- RF-18
    id_conteo  SERIAL PRIMARY KEY,
    id_zona    SMALLINT NOT NULL REFERENCES zona,
    fecha      DATE NOT NULL,
    supervisor VARCHAR(20) NOT NULL REFERENCES usuario
);
CREATE TABLE conteo_linea (
    id_conteo          INTEGER NOT NULL REFERENCES conteo,
    id_tarima          CHAR(18) NOT NULL REFERENCES tarima,
    id_lote            UUID NOT NULL REFERENCES lote,
    cajas_sistema      INTEGER NOT NULL,
    cajas_contadas     INTEGER NOT NULL CHECK (cajas_contadas >= 0),
    posicion_hallada   VARCHAR(16) REFERENCES posicion,
    PRIMARY KEY (id_conteo, id_tarima, id_lote)
);

CREATE TABLE parametro (                                                  -- RNF-11
    clave       VARCHAR(40) PRIMARY KEY,
    valor       NUMERIC NOT NULL,
    descripcion VARCHAR(120) NOT NULL
);

CREATE TABLE bitacora (                                                   -- RF-20 (cambios de estado y catálogo)
    id            BIGSERIAL PRIMARY KEY,
    entidad       VARCHAR(30) NOT NULL,
    operacion     CHAR(1) NOT NULL CHECK (operacion IN ('I', 'U', 'D')),
    valor_anterior JSONB,
    valor_nuevo    JSONB,
    id_usuario    VARCHAR(20),
    fecha_hora    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- =====================================================================
-- Reglas en la base de datos
-- =====================================================================

-- RN-05: frío solo en zona C y la zona C reservada a refrigerados; una tarima no mezcla ambos
CREATE FUNCTION f_verifica_rn05(p_tarima CHAR(18)) RETURNS VOID AS $$
DECLARE
    v_pos VARCHAR(16); v_fria BOOLEAN; n_frio INT; n_amb INT;
BEGIN
    SELECT t.id_posicion INTO v_pos FROM tarima t WHERE t.id_tarima = p_tarima;
    SELECT count(*) FILTER (WHERE p.requiere_frio), count(*) FILTER (WHERE NOT p.requiere_frio)
      INTO n_frio, n_amb
      FROM tarima_lote tl JOIN lote l USING (id_lote) JOIN producto p USING (sku)
     WHERE tl.id_tarima = p_tarima;
    IF n_frio > 0 AND n_amb > 0 THEN
        RAISE EXCEPTION 'RN-05: la tarima % mezcla productos refrigerados y no refrigerados', p_tarima;
    END IF;
    IF v_pos IS NULL THEN RETURN; END IF;
    SELECT z.es_fria INTO v_fria FROM posicion po JOIN zona z USING (id_zona) WHERE po.id_posicion = v_pos;
    IF n_frio > 0 AND NOT v_fria THEN
        RAISE EXCEPTION 'RN-05: la tarima % tiene refrigerados y no puede ir a % (fuera de la cámara)', p_tarima, v_pos;
    END IF;
    IF n_amb > 0 AND v_fria THEN
        RAISE EXCEPTION 'RN-05: la zona C se reserva a refrigerados; la tarima % no puede ir a %', p_tarima, v_pos;
    END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION tg_tarima_rn05() RETURNS TRIGGER AS $$
BEGIN PERFORM f_verifica_rn05(NEW.id_tarima); RETURN NULL; END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER tr_tarima_rn05 AFTER INSERT OR UPDATE OF id_posicion ON tarima
    DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION tg_tarima_rn05();
CREATE CONSTRAINT TRIGGER tr_tarima_lote_rn05 AFTER INSERT ON tarima_lote
    DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION tg_tarima_rn05();

-- Aplicación de cada movimiento al estado (ADR-006)
CREATE FUNCTION tg_aplica_movimiento() RETURNS TRIGGER AS $$
DECLARE
    v_actual VARCHAR(16); v_lote lote%ROWTYPE; v_vigente DATE; v_dia DATE;
BEGIN
    -- Idempotencia (RNF-03): un movimiento reenviado al sincronizar no vuelve a aplicarse.
    -- Se verifica aquí porque un BEFORE INSERT se ejecuta antes de que ON CONFLICT detecte el duplicado.
    PERFORM pg_advisory_xact_lock(hashtext(NEW.id_mov::text));
    IF EXISTS (SELECT 1 FROM movimiento WHERE id_mov = NEW.id_mov) THEN
        RETURN NULL;
    END IF;
    v_dia := (NEW.fecha_dispositivo AT TIME ZONE current_setting('TimeZone'))::date;   -- la base opera en America/Mexico_City
    SELECT id_posicion INTO v_actual FROM tarima WHERE id_tarima = NEW.id_tarima FOR UPDATE;

    IF NEW.tipo IN ('ubicacion', 'reubicacion') THEN
        -- un escaneo hecho sin red con un origen que ya no es el actual se rechaza (RNF-03, CF2)
        IF v_actual IS DISTINCT FROM NEW.pos_origen THEN
            RAISE EXCEPTION 'Origen desactualizado: la tarima % está en %, no en %', NEW.id_tarima, v_actual, NEW.pos_origen;
        END IF;
        UPDATE tarima SET id_posicion = NEW.pos_destino, estado = 'ubicada' WHERE id_tarima = NEW.id_tarima;
        RETURN NEW;
    END IF;

    SELECT * INTO v_lote FROM lote WHERE id_lote = NEW.id_lote;
    v_vigente := COALESCE(v_lote.caducidad_efectiva, v_lote.fecha_caducidad);

    IF NEW.tipo = 'salida' THEN
        IF v_vigente < v_dia THEN                                             -- RN-02 / RF-16
            RAISE EXCEPTION 'RN-02: el lote % caducó el %; no puede surtirse', v_lote.num_lote, v_vigente;
        END IF;
        IF v_lote.estado <> 'disponible' THEN
            RAISE EXCEPTION 'El lote % no está disponible (%)', v_lote.num_lote, v_lote.estado;
        END IF;
        -- RF-12 / RN-09: la base decide si la salida es FEFO; si no lo es, exige motivo
        NEW.es_fefo := NOT EXISTS (
            SELECT 1 FROM tarima_lote tl JOIN lote l USING (id_lote)
             WHERE l.sku = v_lote.sku AND tl.cajas > 0 AND l.estado = 'disponible'
               AND COALESCE(l.caducidad_efectiva, l.fecha_caducidad) >= v_dia
               AND COALESCE(l.caducidad_efectiva, l.fecha_caducidad) < v_vigente);
        IF NOT NEW.es_fefo AND NEW.motivo_excepcion IS NULL THEN
            RAISE EXCEPTION 'RN-09: el lote % no es el FEFO; registre un motivo de excepción', v_lote.num_lote;
        END IF;
    END IF;

    IF NEW.delta_cajas > 0 THEN
        INSERT INTO tarima_lote AS tl (id_tarima, id_lote, cajas)
        VALUES (NEW.id_tarima, NEW.id_lote, NEW.delta_cajas)
        ON CONFLICT (id_tarima, id_lote) DO UPDATE SET cajas = tl.cajas + EXCLUDED.cajas;
    ELSE
        UPDATE tarima_lote SET cajas = cajas + NEW.delta_cajas     -- CHECK cajas >= 0 rechaza saldos negativos
         WHERE id_tarima = NEW.id_tarima AND id_lote = NEW.id_lote;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'El lote % no está en la tarima %', v_lote.num_lote, NEW.id_tarima;
        END IF;
    END IF;

    -- La tarima vacía libera su posición en la misma transacción
    IF NEW.tipo IN ('salida', 'baja', 'ajuste')
       AND NOT EXISTS (SELECT 1 FROM tarima_lote WHERE id_tarima = NEW.id_tarima AND cajas > 0) THEN
        UPDATE tarima SET id_posicion = NULL, estado = 'vacia' WHERE id_tarima = NEW.id_tarima;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tr_aplica_movimiento BEFORE INSERT ON movimiento
    FOR EACH ROW EXECUTE FUNCTION tg_aplica_movimiento();

-- RF-20: movimientos y bitácora son de solo inserción
CREATE FUNCTION tg_solo_insercion() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'RF-20: la tabla % es de solo inserción', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER tr_mov_inmutable BEFORE UPDATE OR DELETE ON movimiento FOR EACH ROW EXECUTE FUNCTION tg_solo_insercion();
CREATE TRIGGER tr_bit_inmutable BEFORE UPDATE OR DELETE ON bitacora   FOR EACH ROW EXECUTE FUNCTION tg_solo_insercion();

-- Bitácora de cambios de estado y catálogo (valor anterior y nuevo)
CREATE FUNCTION tg_bitacora() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO bitacora (entidad, operacion, valor_anterior, valor_nuevo, id_usuario)
    VALUES (TG_TABLE_NAME, left(TG_OP, 1),
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
            current_setting('app.usuario', true));
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bit_tarima    AFTER INSERT OR UPDATE OR DELETE ON tarima    FOR EACH ROW EXECUTE FUNCTION tg_bitacora();
CREATE TRIGGER tr_bit_lote      AFTER INSERT OR UPDATE OR DELETE ON lote      FOR EACH ROW EXECUTE FUNCTION tg_bitacora();
CREATE TRIGGER tr_bit_baja      AFTER INSERT OR UPDATE OR DELETE ON baja      FOR EACH ROW EXECUTE FUNCTION tg_bitacora();
CREATE TRIGGER tr_bit_usuario   AFTER INSERT OR UPDATE OR DELETE ON usuario   FOR EACH ROW EXECUTE FUNCTION tg_bitacora();
CREATE TRIGGER tr_bit_parametro AFTER INSERT OR UPDATE OR DELETE ON parametro FOR EACH ROW EXECUTE FUNCTION tg_bitacora();

-- =====================================================================
-- Vistas de consulta
-- =====================================================================
-- Existencias por lote
CREATE VIEW v_existencia AS
SELECT l.id_lote, l.sku, l.num_lote, COALESCE(l.caducidad_efectiva, l.fecha_caducidad) AS caducidad_vigente,
       l.fecha_recepcion, tl.id_tarima, t.id_posicion, po.profundidad, tl.cajas
  FROM lote l JOIN tarima_lote tl USING (id_lote) JOIN tarima t USING (id_tarima)
  LEFT JOIN posicion po ON po.id_posicion = t.id_posicion
 WHERE tl.cajas > 0;

-- RF-07: cuántas tarimas bloquean a cada tarima en piso (las que están delante en la misma fila)
CREATE VIEW v_bloqueo AS
SELECT t.id_tarima, t.id_posicion, p.fila, p.profundidad,
       (SELECT count(*) FROM tarima t2 JOIN posicion p2 ON p2.id_posicion = t2.id_posicion
         WHERE p2.fila = p.fila AND p2.profundidad < p.profundidad) AS tarimas_delante,
       (SELECT string_agg(t2.id_tarima, ',' ORDER BY p2.profundidad) FROM tarima t2 JOIN posicion p2 ON p2.id_posicion = t2.id_posicion
         WHERE p2.fila = p.fila AND p2.profundidad < p.profundidad) AS bloqueada_por
  FROM tarima t JOIN posicion p ON p.id_posicion = t.id_posicion;

-- RF-11 (C1 de P1): candidato FEFO por producto con su accesibilidad
CREATE VIEW v_candidato_fefo AS
SELECT DISTINCT ON (e.sku) e.sku, e.id_lote, e.num_lote, e.caducidad_vigente, e.id_tarima, e.id_posicion,
       COALESCE(b.tarimas_delante, 0) AS tarimas_delante, b.bloqueada_por
  FROM v_existencia e LEFT JOIN v_bloqueo b USING (id_tarima)
  JOIN lote l USING (id_lote)
 WHERE l.estado = 'disponible' AND e.caducidad_vigente >= current_date
 ORDER BY e.sku, e.caducidad_vigente, e.fecha_recepcion, COALESCE(b.tarimas_delante, 0);       -- RN-01

-- RF-14 / RN-07: nivel de alerta por umbral U(c) y criterio por rotación
CREATE VIEW v_alerta AS
WITH saldo AS (
    SELECT l.id_lote, l.sku, p.id_categoria, COALESCE(l.caducidad_efectiva, l.fecha_caducidad) AS cad, sum(tl.cajas) AS cajas
      FROM lote l JOIN tarima_lote tl USING (id_lote) JOIN producto p USING (sku)
     WHERE l.estado = 'disponible'
     GROUP BY l.id_lote, l.sku, p.id_categoria, cad HAVING sum(tl.cajas) > 0),
demanda AS (
    SELECT l.sku, -sum(m.delta_cajas)::numeric / 14 AS d14
      FROM movimiento m JOIN lote l USING (id_lote)
     WHERE m.tipo = 'salida' AND m.fecha_dispositivo >= now() - interval '14 days'
     GROUP BY l.sku)
SELECT s.id_lote, s.sku, s.cajas, s.cad, (s.cad - current_date) AS dias_restantes, c.umbral_dias,
       CASE WHEN s.cad < current_date THEN 'vencido'
            WHEN s.cad - current_date <= c.umbral_dias / 4.0 THEN 'critico'
            WHEN s.cad - current_date <= c.umbral_dias / 2.0 THEN 'alto'
            WHEN s.cad - current_date <= c.umbral_dias THEN 'preventivo' END AS nivel,
       (d.d14 > 0 AND (s.cad - current_date) < s.cajas / d.d14 + c.vmr_dias + c.tr_dias) AS riesgo_rotacion
  FROM saldo s JOIN categoria c USING (id_categoria) LEFT JOIN demanda d USING (sku);

-- I8: conservación del inventario frente a la bitácora (debe devolver 0 filas)
CREATE VIEW v_conservacion AS
SELECT tl.id_tarima, tl.id_lote, tl.cajas AS saldo, COALESCE(sum(m.delta_cajas), 0) AS suma_movimientos
  FROM tarima_lote tl LEFT JOIN movimiento m ON m.id_tarima = tl.id_tarima AND m.id_lote = tl.id_lote
 GROUP BY tl.id_tarima, tl.id_lote, tl.cajas
HAVING tl.cajas <> COALESCE(sum(m.delta_cajas), 0);

-- I9: la bitácora reproduce la posición física (debe devolver 0 filas)
CREATE VIEW v_posicion_vs_bitacora AS
SELECT t.id_tarima, t.id_posicion, u.pos_destino AS ultima_bitacora
  FROM tarima t
  LEFT JOIN LATERAL (SELECT m.pos_destino FROM movimiento m
                      WHERE m.id_tarima = t.id_tarima AND m.tipo IN ('ubicacion', 'reubicacion')
                      ORDER BY m.fecha_servidor DESC, m.fecha_dispositivo DESC LIMIT 1) u ON TRUE
 WHERE t.estado = 'ubicada' AND t.id_posicion IS DISTINCT FROM u.pos_destino;

-- ---------- Permisos (RNF-08): la aplicación no puede alterar la historia ----------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_fefo') THEN CREATE ROLE app_fefo LOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA fefo TO app_fefo;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA fefo TO app_fefo;
REVOKE UPDATE, DELETE ON movimiento, bitacora FROM app_fefo;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA fefo TO app_fefo;
