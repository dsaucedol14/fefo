-- P3 · Pruebas de integridad del modelo físico (se ejecutan sobre 01 y 02)
-- Cada prueba intenta una operación válida o una violación y registra si la
-- base de datos se comportó como exige el requerimiento.
SET search_path = fefo;
SET app.usuario = 'alm01';

CREATE TEMP TABLE resultado (id TEXT, requerimiento TEXT, descripcion TEXT, esperado TEXT, obtenido TEXT, estado TEXT, detalle TEXT);

CREATE FUNCTION pg_temp.prueba(p_id TEXT, p_req TEXT, p_desc TEXT, p_cmd TEXT, p_debe_fallar BOOLEAN) RETURNS VOID AS $$
BEGIN
    BEGIN
        EXECUTE p_cmd;
        INSERT INTO resultado VALUES (p_id, p_req, p_desc, CASE WHEN p_debe_fallar THEN 'rechazo' ELSE 'acepta' END,
               'acepta', CASE WHEN p_debe_fallar THEN 'FALLA' ELSE 'PASA' END, '');
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO resultado VALUES (p_id, p_req, p_desc, CASE WHEN p_debe_fallar THEN 'rechazo' ELSE 'acepta' END,
               'rechazo', CASE WHEN p_debe_fallar THEN 'PASA' ELSE 'FALLA' END, SQLERRM);
    END;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.afirma(p_cond BOOLEAN, p_msg TEXT) RETURNS VOID AS $$
BEGIN IF NOT COALESCE(p_cond, FALSE) THEN RAISE EXCEPTION 'Afirmación falsa: %', p_msg; END IF; END $$ LANGUAGE plpgsql;

-- ---------- Escenario ----------
INSERT INTO producto VALUES ('7500000000011', 'Leche entera 1 L caja 12', 1, TRUE, 22, 312.50),
                            ('7500000000028', 'Arroz 1 kg caja 20',       3, FALSE, 240, 410.00);
INSERT INTO lote (id_lote, sku, num_lote, fecha_caducidad, fecha_recepcion) VALUES
    ('00000000-0000-0000-0000-0000000000a1', '7500000000011', 'LCH-01', current_date + 5,  current_date - 3),
    ('00000000-0000-0000-0000-0000000000a2', '7500000000011', 'LCH-02', current_date + 10, current_date - 1),
    ('00000000-0000-0000-0000-0000000000a0', '7500000000011', 'LCH-00', current_date - 1,  current_date - 20),
    ('00000000-0000-0000-0000-0000000000b1', '7500000000028', 'ARZ-01', current_date + 200, current_date - 2);
INSERT INTO tarima (id_tarima) VALUES ('000000000000000001'), ('000000000000000002'), ('000000000000000003'),
                                      ('000000000000000004'), ('000000000000000005'), ('000000000000000006');
CREATE FUNCTION pg_temp.mov(p_tipo tipo_mov, p_tarima TEXT, p_lote UUID, p_delta INT, p_ori TEXT, p_des TEXT,
                            p_motivo motivo_fefo DEFAULT NULL, p_id UUID DEFAULT gen_random_uuid()) RETURNS VOID AS $$
    INSERT INTO fefo.movimiento (id_mov, tipo, id_tarima, id_lote, delta_cajas, pos_origen, pos_destino, motivo_excepcion,
                                 id_usuario, fecha_dispositivo)
    VALUES (p_id, p_tipo, p_tarima, p_lote, p_delta, p_ori, p_des, p_motivo, 'alm01', now());
$$ LANGUAGE sql;
-- T1: leche LCH-02 (30 cajas), T2: leche LCH-01 (20), T3: arroz (40), T6: leche vencida LCH-00 (5)
SELECT pg_temp.mov('recepcion', '000000000000000001', '00000000-0000-0000-0000-0000000000a2', 30, NULL, NULL);
SELECT pg_temp.mov('recepcion', '000000000000000002', '00000000-0000-0000-0000-0000000000a1', 20, NULL, NULL);
SELECT pg_temp.mov('recepcion', '000000000000000003', '00000000-0000-0000-0000-0000000000b1', 40, NULL, NULL);
SELECT pg_temp.mov('recepcion', '000000000000000004', '00000000-0000-0000-0000-0000000000b1', 40, NULL, NULL);
SELECT pg_temp.mov('recepcion', '000000000000000006', '00000000-0000-0000-0000-0000000000a0', 5, NULL, NULL);
SELECT pg_temp.mov('ubicacion', '000000000000000001', NULL, 0, NULL, 'C-R01-N1');
SELECT pg_temp.mov('ubicacion', '000000000000000002', NULL, 0, NULL, 'C-R01-N2');
SELECT pg_temp.mov('ubicacion', '000000000000000003', NULL, 0, NULL, 'B-F01-D1');
SELECT pg_temp.mov('ubicacion', '000000000000000006', NULL, 0, NULL, 'C-R02-N1');

-- ---------- Pruebas ----------
SELECT pg_temp.prueba('PI-01', 'RNF-07 / I1', 'Ubicar una segunda tarima en una posición ocupada',
  $$SELECT pg_temp.mov('ubicacion', '000000000000000004', NULL, 0, NULL, 'B-F01-D1')$$, TRUE);
SELECT pg_temp.prueba('PI-02', 'RN-05', 'Ubicar una tarima de leche fuera de la cámara (zona A)',
  $$SELECT pg_temp.mov('reubicacion', '000000000000000001', NULL, 0, 'C-R01-N1', 'A-P01-R01-N1')$$, TRUE);
SELECT pg_temp.prueba('PI-03', 'RN-05', 'Ubicar una tarima de arroz en la cámara (C reservada a frío)',
  $$SELECT pg_temp.mov('ubicacion', '000000000000000004', NULL, 0, NULL, 'C-R05-N1')$$, TRUE);
SELECT pg_temp.prueba('PI-04', 'RN-05 / RN-06', 'Agregar un lote refrigerado a una tarima de arroz',
  $$SELECT pg_temp.mov('recepcion', '000000000000000003', '00000000-0000-0000-0000-0000000000a1', 5, NULL, NULL)$$, TRUE);
SELECT pg_temp.prueba('PI-05', 'RF-12 / RN-09', 'Surtir LCH-02 (no FEFO) sin motivo de excepción',
  $$SELECT pg_temp.mov('salida', '000000000000000001', '00000000-0000-0000-0000-0000000000a2', -5, NULL, NULL)$$, TRUE);
SELECT pg_temp.prueba('PI-06', 'RF-12 / RN-09', 'Surtir LCH-02 con motivo «lote pedido por el cliente»',
  $$SELECT pg_temp.mov('salida', '000000000000000001', '00000000-0000-0000-0000-0000000000a2', -5, NULL, NULL, 'lote_pedido_cliente',
       '00000000-0000-0000-0000-00000000f006')$$, FALSE);
SELECT pg_temp.prueba('PI-07', 'RF-12', 'La base marca la salida anterior como no FEFO',
  $$SELECT pg_temp.afirma((SELECT NOT es_fefo FROM movimiento WHERE id_mov = '00000000-0000-0000-0000-00000000f006'), 'es_fefo')$$, FALSE);
SELECT pg_temp.prueba('PI-08', 'RF-11 / RN-01', 'Surtir LCH-01 (FEFO) sin motivo y quedar marcada como FEFO',
  $$SELECT pg_temp.mov('salida', '000000000000000002', '00000000-0000-0000-0000-0000000000a1', -5, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000f008');
    SELECT pg_temp.afirma((SELECT es_fefo FROM movimiento WHERE id_mov = '00000000-0000-0000-0000-00000000f008'), 'es_fefo')$$, FALSE);
SELECT pg_temp.prueba('PI-09', 'RF-13 / RNF-07', 'Surtir más cajas de las que tiene el lote',
  $$SELECT pg_temp.mov('salida', '000000000000000002', '00000000-0000-0000-0000-0000000000a1', -500, NULL, NULL)$$, TRUE);
SELECT pg_temp.prueba('PI-10', 'RN-02 / RF-16', 'Surtir un lote caducado',
  $$SELECT pg_temp.mov('salida', '000000000000000006', '00000000-0000-0000-0000-0000000000a0', -1, NULL, NULL, 'decision_operador')$$, TRUE);
SELECT pg_temp.prueba('PI-11', 'RF-20', 'Modificar un movimiento ya registrado',
  $$UPDATE movimiento SET delta_cajas = delta_cajas$$, TRUE);
SELECT pg_temp.prueba('PI-12', 'RF-20', 'Borrar un movimiento ya registrado',
  $$DELETE FROM movimiento$$, TRUE);
SELECT pg_temp.prueba('PI-13', 'RN-08 / RF-17', 'Autorizar una baja con el mismo usuario que la registró',
  $$INSERT INTO baja (id_lote, id_tarima, cajas, motivo, registrado_por, autorizado_por)
    VALUES ('00000000-0000-0000-0000-0000000000a0', '000000000000000006', 5, 'caducidad', 'sup01', 'sup01')$$, TRUE);
SELECT pg_temp.prueba('PI-14', 'RF-17', 'Baja pendiente sin autorización no descuenta existencias',
  $$INSERT INTO baja (id_lote, id_tarima, cajas, motivo, registrado_por)
    VALUES ('00000000-0000-0000-0000-0000000000a0', '000000000000000006', 5, 'caducidad', 'alm01');
    SELECT pg_temp.afirma((SELECT cajas FROM tarima_lote WHERE id_tarima = '000000000000000006') = 5, 'saldo intacto')$$, FALSE);
SELECT pg_temp.prueba('PI-15', 'RNF-03 / CF2', 'Reubicación sincronizada con un origen que ya no es el actual',
  $$SELECT pg_temp.mov('reubicacion', '000000000000000003', NULL, 0, 'B-F09-D1', 'B-F02-D1')$$, TRUE);
SELECT pg_temp.prueba('PI-16', 'RNF-03', 'Reenviar el mismo movimiento al sincronizar no duplica su efecto',
  $$INSERT INTO movimiento (id_mov, tipo, id_tarima, id_lote, delta_cajas, id_usuario, fecha_dispositivo)
    VALUES ('00000000-0000-0000-0000-00000000f008', 'salida', '000000000000000002', '00000000-0000-0000-0000-0000000000a1', -5, 'alm01', now())
    ON CONFLICT (id_mov) DO NOTHING;
    SELECT pg_temp.afirma((SELECT cajas FROM tarima_lote WHERE id_tarima = '000000000000000002') = 15, 'saldo 15')$$, FALSE);
SELECT pg_temp.prueba('PI-17', 'I3 (P2)', 'Una tarima que se vacía libera su posición y otra puede ocuparla',
  $$SELECT pg_temp.mov('salida', '000000000000000002', '00000000-0000-0000-0000-0000000000a1', -15, NULL, NULL);
    SELECT pg_temp.afirma((SELECT estado = 'vacia' AND id_posicion IS NULL FROM tarima WHERE id_tarima = '000000000000000002'), 'vacía');
    SELECT pg_temp.mov('reubicacion', '000000000000000001', NULL, 0, 'C-R01-N1', 'C-R01-N2')$$, FALSE);
SELECT pg_temp.prueba('PI-18', 'RN-04', 'Crear una posición con formato inválido',
  $$INSERT INTO posicion (id_posicion, id_zona) VALUES ('A-1-1', 1)$$, TRUE);
SELECT pg_temp.prueba('PI-19', 'RF-04', 'Registrar un lote que caduca antes de recibirse',
  $$INSERT INTO lote (sku, num_lote, fecha_caducidad, fecha_recepcion) VALUES ('7500000000011', 'MAL', current_date - 5, current_date)$$, TRUE);
SELECT pg_temp.prueba('PI-20', 'RF-07', 'La vista de bloqueo cuenta las tarimas que hay delante en la fila',
  $$SELECT pg_temp.mov('ubicacion', '000000000000000004', NULL, 0, NULL, 'B-F01-D2');
    SELECT pg_temp.afirma((SELECT tarimas_delante = 1 AND bloqueada_por = '000000000000000003' FROM v_bloqueo WHERE id_tarima = '000000000000000004'), 'bloqueo')$$, FALSE);
SELECT pg_temp.prueba('PI-21', 'RF-11 (C1)', 'El candidato FEFO de la leche es el lote vigente de caducidad más próxima',
  $$SELECT pg_temp.afirma((SELECT num_lote = 'LCH-02' FROM v_candidato_fefo WHERE sku = '7500000000011'), 'candidato')$$, FALSE);
SELECT pg_temp.prueba('PI-22', 'RF-14 / RN-07', 'La alerta clasifica la leche que vence en 10 días con U(c) = 7 como sin alerta y la vencida como vencida',
  $$SELECT pg_temp.afirma((SELECT nivel IS NULL FROM v_alerta WHERE id_lote = '00000000-0000-0000-0000-0000000000a2'), 'sin alerta');
    SELECT pg_temp.afirma((SELECT nivel = 'vencido' FROM v_alerta WHERE id_lote = '00000000-0000-0000-0000-0000000000a0'), 'vencido')$$, FALSE);
SELECT pg_temp.prueba('PI-23', 'RNF-07 / I8', 'El saldo de cada tarima-lote es igual a la suma de sus movimientos',
  $$SELECT pg_temp.afirma((SELECT count(*) = 0 FROM v_conservacion), 'conservación')$$, FALSE);
SELECT pg_temp.prueba('PI-24', 'RF-20 / I9', 'La bitácora reproduce la posición de cada tarima ubicada',
  $$SELECT pg_temp.afirma((SELECT count(*) = 0 FROM v_posicion_vs_bitacora), 'bitácora')$$, FALSE);
SELECT pg_temp.prueba('PI-25', 'RF-20', 'Cada cambio de posición deja valor anterior y nuevo en la bitácora',
  $$SELECT pg_temp.afirma((SELECT count(*) > 0 FROM bitacora WHERE entidad = 'tarima' AND operacion = 'U'
       AND valor_anterior->>'id_posicion' = 'C-R01-N1' AND valor_nuevo->>'id_posicion' = 'C-R01-N2' AND id_usuario = 'alm01'), 'bitácora')$$, FALSE);
SELECT pg_temp.prueba('PI-26', 'RF-20', 'La bitácora tampoco se puede modificar',
  $$UPDATE bitacora SET id_usuario = 'x'$$, TRUE);
SELECT pg_temp.prueba('PI-27', 'RNF-08', 'Una cuenta queda bloqueada al quinto intento fallido',
  $$UPDATE usuario SET intentos_fallidos = 5 WHERE id_usuario = 'alm02';
    SELECT pg_temp.afirma((SELECT bloqueado FROM usuario WHERE id_usuario = 'alm02'), 'bloqueo')$$, FALSE);

\pset footer off
SELECT id, requerimiento, descripcion, esperado, obtenido, estado, left(detalle, 90) AS detalle FROM resultado ORDER BY id;
SELECT count(*) FILTER (WHERE estado = 'PASA') AS pasan, count(*) FILTER (WHERE estado = 'FALLA') AS fallan FROM resultado;
\copy (SELECT * FROM resultado ORDER BY id) TO 'resultados_pruebas.csv' WITH CSV HEADER
