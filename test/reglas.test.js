const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/dominio/reglas');
const { idTarima, idTarimaValido, digitoVerificador } = require('../src/dominio/ids');
const GS1 = require('../src/dominio/gs1');

const HOY = '2026-11-21';
const c = (id, cad, rec, prof, libres, extra = {}) => ({
  id_lote: id, id_tarima: `T${id}`, fecha_caducidad: cad, fecha_recepcion: rec, profundidad: prof,
  libres, id_posicion: 'B-F01-D1', ...extra,
});

test('RN-01: propone el lote de caducidad más próxima aunque haya llegado después', () => {
  const cands = [c('A', '2026-11-30', '2026-11-01', 1, 10), c('B', '2026-11-25', '2026-11-04', 1, 10),
    c('C', '2026-12-15', '2026-11-02', 1, 10)];
  assert.equal(R.loteFefo(cands, HOY).id_lote, 'B');
});

test('RN-01: con caducidad empatada gana la recepción más antigua y luego la menor profundidad', () => {
  assert.equal(R.loteFefo([c('A', '2026-11-30', '2026-11-05', 1, 5), c('B', '2026-11-30', '2026-11-02', 3, 5)], HOY).id_lote, 'B');
  assert.equal(R.loteFefo([c('A', '2026-11-30', '2026-11-02', 3, 5), c('B', '2026-11-30', '2026-11-02', 1, 5)], HOY).id_lote, 'B');
});

test('C1: un lote FEFO bloqueado al fondo sigue siendo la propuesta', () => {
  const cands = [c('FONDO', '2026-11-25', '2026-11-01', 4, 10), c('FRENTE', '2026-12-20', '2026-11-01', 1, 10)];
  assert.equal(R.asignarFefo(cands, 5, HOY).partidas[0].id_lote, 'FONDO');
});

test('RN-02: el caducado no se asigna; el que caduca hoy sí', () => {
  const cands = [c('AYER', '2026-11-20', '2026-10-01', 1, 10), c('HOY', '2026-11-21', '2026-10-01', 1, 10)];
  const r = R.asignarFefo(cands, 3, HOY);
  assert.deepEqual(r.partidas.map((p) => p.id_lote), ['HOY']);
});

test('RF-06: una tarima por ubicar no es elegible', () => {
  const r = R.asignarFefo([c('X', '2026-11-25', '2026-11-01', 1, 10, { id_posicion: null })], 3, HOY);
  assert.equal(r.partidas.length, 0);
  assert.equal(r.faltante, 3);
});

test('asignación reparte entre lotes en orden FEFO y respeta las cajas libres (reservas)', () => {
  const cands = [c('A', '2026-11-25', '2026-11-01', 1, 4), c('B', '2026-11-28', '2026-11-01', 1, 10)];
  const r = R.asignarFefo(cands, 7, HOY);
  assert.deepEqual(r.partidas.map((p) => [p.id_lote, p.cajas]), [['A', 4], ['B', 3]]);
  assert.equal(r.faltante, 0);
  assert.equal(R.asignarFefo(cands, 20, HOY).faltante, 6);
});

test('la caducidad efectiva sustituye a la impresa', () => {
  const cands = [c('A', '2026-12-30', '2026-11-01', 1, 5, { caducidad_efectiva: '2026-11-23' }), c('B', '2026-11-28', '2026-11-01', 1, 5)];
  assert.equal(R.loteFefo(cands, HOY).id_lote, 'A');
});

test('U(c): ejemplos de la Sección VII.E (lácteo 7 días, abarrote 40 días)', () => {
  assert.deepEqual(R.umbral({ vu_dias: 22, vmr_dias: 3, tr_dias: 2, ms_dias: 2 }), { U: 7, supuesto: false });
  assert.deepEqual(R.umbral({ vu_dias: 365, vmr_dias: 30, tr_dias: 5, ms_dias: 5 }), { U: 40, supuesto: false });
  assert.deepEqual(R.umbral({ vu_dias: 20, vmr_dias: 30, tr_dias: 5, ms_dias: 5 }), { U: 20, supuesto: false });
  assert.deepEqual(R.umbral({ vu_dias: null, vmr_dias: null }), { U: 30, supuesto: true });
});

test('RN-07: casos límite de cada nivel y uno con un día más de margen fuera', () => {
  const U = 30;
  assert.equal(R.nivelAlerta(-1, U), 'VENCIDO');
  assert.equal(R.nivelAlerta(0, U), 'CRITICO');
  assert.equal(R.nivelAlerta(7, U), 'CRITICO');
  assert.equal(R.nivelAlerta(8, U), 'ALTO');
  assert.equal(R.nivelAlerta(15, U), 'ALTO');
  assert.equal(R.nivelAlerta(16, U), 'PREVENTIVO');
  assert.equal(R.nivelAlerta(30, U), 'PREVENTIVO');
  assert.equal(R.nivelAlerta(31, U), null);
  assert.equal(R.nivelAlerta(7, 7), 'PREVENTIVO');
  assert.equal(R.nivelAlerta(8, 7), null);
});

test('criterio por rotación: R < Q/d̄ + VMR + TR', () => {
  assert.equal(R.riesgoRotacion({ R: 10, Q: 40, demanda: 4, vmr: 0, tr: 2 }), true); // 10 < 12
  assert.equal(R.riesgoRotacion({ R: 12, Q: 40, demanda: 4, vmr: 0, tr: 2 }), false); // 12 < 12 no
  assert.equal(R.riesgoRotacion({ R: 1, Q: 40, demanda: 0, vmr: 0, tr: 2 }), false); // sin demanda
});

test('RN-03: rechaza vencidos, pide autorización bajo el mínimo y acepta el resto', () => {
  const cat = { vmr_dias: 3, tr_dias: 2 };
  assert.equal(R.evaluarRecepcion({ caducidad: '2026-11-20', hoy: HOY, cajas: 10, demanda: 2, categoria: cat }).estado, 'RECHAZAR');
  // cobertura 10/2 = 5 + VMR 3 = 8 días mínimos
  assert.equal(R.evaluarRecepcion({ caducidad: '2026-11-28', hoy: HOY, cajas: 10, demanda: 2, categoria: cat }).estado, 'AUTORIZAR');
  assert.equal(R.evaluarRecepcion({ caducidad: '2026-11-29', hoy: HOY, cajas: 10, demanda: 2, categoria: cat }).estado, 'OK');
  // sin demanda la cobertura es TR (2) + VMR (3) = 5
  assert.equal(R.evaluarRecepcion({ caducidad: '2026-11-26', hoy: HOY, cajas: 10, demanda: 0, categoria: cat }).estado, 'OK');
});

test('CF4: ID de tarima de 18 dígitos con verificador GS1', () => {
  assert.equal(digitoVerificador('400638133393'), 1); // EAN-13 válido conocido: 4006381333931
  const id = idTarima('0750123', 1234);
  assert.equal(id.length, 18);
  assert.equal(idTarimaValido(id), true);
  assert.equal(idTarimaValido(id.slice(0, 17) + ((Number(id[17]) + 1) % 10)), false);
});

test('GS1: lee la forma legible y la cruda con separador', () => {
  assert.deepEqual(GS1.leer('(01)07501234567890(17)261128(10)L2611A'),
    { gtin: '07501234567890', lote: 'L2611A', caducidad: '2026-11-28', fuenteFecha: '17' });
  assert.deepEqual(GS1.leer(']C1010750123456789010L2611A\x1d17261100'),
    { gtin: '07501234567890', lote: 'L2611A', caducidad: '2026-11-30', fuenteFecha: '17' });
  assert.equal(GS1.leer('B-F07-D3'), null);
  assert.deepEqual(GS1.clavesProducto('07501234567890'), ['07501234567890', '7501234567890']);
});
