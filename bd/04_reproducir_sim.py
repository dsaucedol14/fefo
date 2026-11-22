"""
04_reproducir_sim.py - Reproduce en la base de datos las transacciones del caso simulado de P2.

Lee los CSV que genera sim.py (P2 v2) y escribe un guion SQL que inserta cada recepción,
ubicación, reubicación, salida y baja como MOVIMIENTO. Los disparadores del esquema aplican
cada movimiento al estado y verifican RN-02, RN-05, RN-09 y la ocupación. Al final se compara:
  - el saldo de cada lote en la base contra cajas_finales del simulador;
  - la marca es_fefo que calcula la base contra conforme_fefo del simulador;
  - las vistas de conservación (I8) y de bitácora (I9), que deben quedar vacías.

Uso:  python 04_reproducir_sim.py <carpeta_csv_de_sim.py> <salida.sql> [--v1]
      psql -d fefo_p3 -f salida.sql
Con --v1 se agregan las posiciones de la distribución de la versión 1 (A con 4 pasillos);
se espera que la base rechace las ubicaciones de refrigerados fuera de la cámara (RN-05).
"""
import csv
import sys
import uuid

src, out = sys.argv[1], sys.argv[2]
v1 = '--v1' in sys.argv
NS = uuid.UUID('6f1c2a6e-1d2b-4c1e-9a33-2b7f6a0c9d11')


def rd(n):
    with open(f'{src}/{n}', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def tid(t):
    return f'{int(t[1:]):018d}'


def lid(l):
    return str(uuid.uuid5(NS, l))


cats = {'Lácteos': 1, 'Embutidos': 2, 'Abarrotes': 3, 'Bebidas': 4, 'Botanas': 5}
prods = rd('productos.csv'); lotes = rd('lotes.csv'); movs = rd('movimientos.csv'); sels = rd('selecciones.csv')
lotes_por_tarima = {}
for l in lotes:
    lotes_por_tarima.setdefault(l['tarima'], []).append(l)

o = open(out, 'w', encoding='utf-8')
w = o.write
w("SET search_path = fefo;\nSET app.usuario = 'alm01';\n\\set ON_ERROR_STOP 0\n")
w("DROP SCHEMA IF EXISTS replay CASCADE; CREATE SCHEMA replay;\n")
w("CREATE TABLE replay.sel (id_mov UUID PRIMARY KEY, conforme BOOLEAN);\nCREATE TABLE replay.final (id_lote UUID PRIMARY KEY, cajas INT);\n")
if v1:
    w("INSERT INTO posicion (id_posicion, id_zona, profundidad) SELECT format('A-P04-R%s-N%s', lpad(r::text,2,'0'), n), 1, 1 "
      "FROM generate_series(1,8) r, generate_series(1,3) n ON CONFLICT DO NOTHING;\n")
w("BEGIN;\n")
for p in prods:
    w(f"INSERT INTO producto VALUES ('{p['sku']}', 'Producto {p['sku']}', {cats[p['categoria']]}, {p['frio'].lower()}, "
      f"{p['vida_util_dias']}, {p['costo_caja']});\n")
for l in lotes:
    w(f"INSERT INTO lote (id_lote, sku, num_lote, fecha_caducidad, fecha_recepcion) VALUES ('{lid(l['lote'])}', '{l['sku']}', "
      f"'{l['lote']}', '{l['fecha_caducidad']}', '{l['fecha_recepcion']}');\n")
    w(f"INSERT INTO replay.final VALUES ('{lid(l['lote'])}', {l['cajas_finales']});\n")
for t in sorted(lotes_por_tarima):
    w(f"INSERT INTO tarima (id_tarima) VALUES ('{tid(t)}');\n")
w("COMMIT;\n")

seg = {}
it = iter(sels)


def ts(fecha):
    seg[fecha] = seg.get(fecha, 0) + 1
    s = seg[fecha]
    return f"{fecha} {6 + s // 3600:02d}:{(s // 60) % 60:02d}:{s % 60:02d}-06"


def mov(tipo, t, lote=None, delta=0, ori=None, des=None, motivo=None, fecha=None, idm=None):
    idm = idm or str(uuid.uuid4())
    q = lambda v: 'NULL' if v is None else f"'{v}'"
    w(f"INSERT INTO movimiento (id_mov, tipo, id_tarima, id_lote, delta_cajas, pos_origen, pos_destino, motivo_excepcion, "
      f"id_usuario, fecha_dispositivo) VALUES ('{idm}', '{tipo}', '{tid(t)}', {q(lote)}, {delta}, {q(ori)}, {q(des)}, "
      f"{q(motivo)}, 'alm01', '{ts(fecha)}');\n")
    return idm


for m in movs:
    f = m['fecha']
    if m['tipo'] == 'ENTRADA':
        for l in lotes_por_tarima[m['tarima']]:
            mov('recepcion', m['tarima'], lid(l['lote']), int(l['cajas_recibidas']), fecha=f)
        mov('ubicacion', m['tarima'], des=m['destino'], fecha=f)
    elif m['tipo'] == 'REUBICACION':
        mov('reubicacion', m['tarima'], ori=m['origen'], des=m['destino'], fecha=f)
    elif m['tipo'] == 'SALIDA':
        s = next(it)
        assert s['lote_elegido'] == m['lote'] and s['fecha'] == f
        conforme = s['conforme_fefo'] == '1'
        idm = mov('salida', m['tarima'], lid(m['lote']), -int(m['cajas']), motivo=None if conforme else 'decision_operador', fecha=f)
        w(f"INSERT INTO replay.sel VALUES ('{idm}', {str(conforme).lower()});\n")
    elif m['tipo'] == 'BAJA_CADUCIDAD':
        mov('baja', m['tarima'], lid(m['lote']), -int(m['cajas']), fecha=f)

w("""
\\echo '--- Resultado de la reproducción ---'
SELECT (SELECT count(*) FROM movimiento) AS movimientos_aceptados,
       (SELECT count(*) FROM replay.sel) AS salidas_simuladas,
       (SELECT count(*) FROM replay.sel s JOIN movimiento m USING (id_mov)) AS salidas_aceptadas,
       (SELECT count(*) FROM replay.sel s JOIN movimiento m USING (id_mov) WHERE m.es_fefo = s.conforme) AS es_fefo_coincide,
       (SELECT round(100.0 * avg(m.es_fefo::int), 1) FROM movimiento m WHERE m.tipo = 'salida') AS conformidad_fefo_pct,
       (SELECT count(*) FROM replay.final f LEFT JOIN (SELECT id_lote, sum(cajas) c FROM tarima_lote GROUP BY id_lote) t USING (id_lote)
         WHERE f.cajas <> COALESCE(t.c, 0)) AS lotes_con_saldo_distinto,
       (SELECT count(*) FROM v_conservacion) AS incidencias_I8,
       (SELECT count(*) FROM v_posicion_vs_bitacora) AS incidencias_I9,
       (SELECT count(*) FROM tarima t JOIN tarima_lote tl USING (id_tarima) JOIN lote l USING (id_lote) JOIN producto p USING (sku)
         JOIN posicion po ON po.id_posicion = t.id_posicion JOIN zona z USING (id_zona)
         WHERE p.requiere_frio AND NOT z.es_fria) AS refrigerados_fuera_de_C;
""")
o.close()
print('ok', out)
