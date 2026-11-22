-- P3 · Prueba de rendimiento de consultas (RNF-01): 5 000 lotes, 232 posiciones ocupadas
SET search_path = fefo;
SET app.usuario = 'alm01';
INSERT INTO producto SELECT format('75%s', lpad(i::text, 11, '0')), 'Producto '||i, 3, FALSE, 240, 100 FROM generate_series(1, 200) i;
INSERT INTO lote (id_lote, sku, num_lote, fecha_caducidad, fecha_recepcion)
SELECT md5('l'||i)::uuid, format('75%s', lpad((1 + i % 200)::text, 11, '0')), 'R'||lpad(i::text, 6, '0'),
       current_date + 30 + (i % 300), current_date - (i % 20) FROM generate_series(1, 5000) i;
INSERT INTO tarima (id_tarima) SELECT lpad((900000 + i)::text, 18, '0') FROM generate_series(1, 1000) i;
INSERT INTO movimiento (id_mov, tipo, id_tarima, id_lote, delta_cajas, id_usuario, fecha_dispositivo)
SELECT gen_random_uuid(), 'recepcion', lpad((900000 + 1 + (i % 1000))::text, 18, '0'), md5('l'||i)::uuid, 20, 'alm01', now()
  FROM generate_series(1, 5000) i;
-- ubicar 184 tarimas en las posiciones de A y B
INSERT INTO movimiento (id_mov, tipo, id_tarima, pos_destino, id_usuario, fecha_dispositivo)
SELECT gen_random_uuid(), 'ubicacion', lpad((900000 + rn)::text, 18, '0'), id_posicion, 'alm01', now()
  FROM (SELECT id_posicion, row_number() OVER (ORDER BY id_posicion) rn FROM posicion WHERE id_posicion !~ '^C') p;
ANALYZE;
\timing on
\echo 'Búsqueda de un lote por número (RF-09) con su bloqueo'
SELECT e.num_lote, e.id_posicion, b.tarimas_delante FROM v_existencia e LEFT JOIN v_bloqueo b USING (id_tarima) WHERE e.num_lote = 'R004321';
\echo 'Candidato FEFO de un producto (RF-11)'
SELECT * FROM v_candidato_fefo WHERE sku = '7500000000123';
\echo 'Alertas del día (RF-14)'
SELECT count(*) FROM v_alerta WHERE nivel IS NOT NULL OR riesgo_rotacion;
