-- P3 · Datos de catálogo del almacén piloto simulado (A 72, B 112, C 48)
SET search_path = fefo;

INSERT INTO empresa (nombre) VALUES ('Distribuidora Sierra Norte (caso simulado)');
INSERT INTO almacen (id_empresa, nombre) VALUES (1, 'Almacén piloto');
INSERT INTO zona (id_almacen, codigo, tipo, es_fria) VALUES
    (1, 'A', 'rack', FALSE), (1, 'B', 'piso', FALSE), (1, 'C', 'camara', TRUE);

-- Zona A: 3 pasillos x 8 racks x 3 niveles
INSERT INTO posicion (id_posicion, id_zona, profundidad)
SELECT format('A-P%s-R%s-N%s', lpad(p::text, 2, '0'), lpad(r::text, 2, '0'), n), 1, 1
  FROM generate_series(1, 3) p, generate_series(1, 8) r, generate_series(1, 3) n;
-- Zona B: 28 filas x 4 de profundidad (1 = frente)
INSERT INTO posicion (id_posicion, id_zona, fila, profundidad)
SELECT format('B-F%s-D%s', lpad(f::text, 2, '0'), d), 2, format('B-F%s', lpad(f::text, 2, '0')), d
  FROM generate_series(1, 28) f, generate_series(1, 4) d;
-- Zona C: 24 racks x 2 niveles
INSERT INTO posicion (id_posicion, id_zona, profundidad)
SELECT format('C-R%s-N%s', lpad(r::text, 2, '0'), n), 3, 1
  FROM generate_series(1, 24) r, generate_series(1, 2) n;

-- Categorías y parámetros del umbral U(c) = mín{VU, VMR + TR + MS} (valores iniciales por calibrar)
INSERT INTO categoria (nombre, conservacion, vu_dias, vmr_dias, tr_dias, ms_dias) VALUES
    ('Lácteos',   'refrigerado', 25,  3, 2, 2),
    ('Embutidos', 'refrigerado', 35,  5, 2, 2),
    ('Abarrotes', 'ambiente',   240, 30, 5, 5),
    ('Bebidas',   'ambiente',   180, 30, 5, 5),
    ('Botanas',   'ambiente',    90, 20, 4, 4);

INSERT INTO usuario (id_usuario, nombre, rol, hash_contrasena) VALUES
    ('alm01', 'Almacenista 1', 'almacenista', 'bcrypt$pendiente'),
    ('alm02', 'Almacenista 2', 'almacenista', 'bcrypt$pendiente'),
    ('sup01', 'Supervisor 1',  'supervisor',  'bcrypt$pendiente'),
    ('sup02', 'Supervisor 2',  'supervisor',  'bcrypt$pendiente'),
    ('adm01', 'Administración','administracion', 'bcrypt$pendiente');

INSERT INTO parametro (clave, valor, descripcion) VALUES
    ('ajuste_max_cajas',      5,  'RN-10: ajuste mayor requiere autorización del supervisor'),
    ('ajuste_max_pct',        2,  'RN-10: ajuste mayor al % del lote requiere autorización'),
    ('ventana_demanda_dias', 14,  'Criterio por rotación: días para la demanda media'),
    ('intentos_bloqueo',      5,  'RNF-08: intentos fallidos antes de bloquear'),
    ('horas_sin_red_nivel1',  2,  'RNF-03 nivel 1: horas mínimas de captura sin red'),
    ('umbral_omision',       30,  'Días de alerta por omisión cuando falta la categoría');
