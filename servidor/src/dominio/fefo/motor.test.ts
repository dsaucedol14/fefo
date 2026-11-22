import { describe, expect, it } from 'vitest';
import { recomendar, esFefo, nivelAlerta, umbral, riesgoRotacion, evaluarRecepcion, elegibles, type Candidato } from './motor.js';
import { digitoVerificador, idTarima, idTarimaValido } from '../ids.js';

const HOY = '2026-11-21';
const c = (lote: string, cad: string, rec: string, delante = 0, saldo = 10, extra: Partial<Candidato> = {}): Candidato => ({
  id_lote: lote, num_lote: lote, id_tarima: `T-${lote}`, id_posicion: 'B-F01-D1', caducidad_vigente: cad,
  fecha_recepcion: rec, saldo, tarimas_delante: delante, bloqueada_por: Array.from({ length: delante }, (_, i) => `B${i}`), ...extra,
});

describe('PU-01 orden RN-01', () => {
  it('propone la caducidad más próxima aunque haya llegado después (Tabla IV de P1)', () => {
    const r = recomendar(5, HOY, [c('T001', '2026-11-30', '2026-11-01'), c('T002', '2026-11-25', '2026-11-04'), c('T003', '2026-12-15', '2026-11-02')]);
    expect(r.lineas[0].lote.id_lote).toBe('T002');
  });
  it('con caducidad empatada gana la recepción más antigua y luego menos tarimas delante', () => {
    expect(recomendar(1, HOY, [c('A', '2026-11-30', '2026-11-05'), c('B', '2026-11-30', '2026-11-02', 2)]).lineas[0].lote.id_lote).toBe('B');
    expect(recomendar(1, HOY, [c('A', '2026-11-30', '2026-11-02', 2), c('B', '2026-11-30', '2026-11-02', 0)]).lineas[0].lote.id_lote).toBe('B');
  });
  it('RN-02: lo vencido no es candidato; lo que caduca hoy sí', () => {
    const r = recomendar(3, HOY, [c('AYER', '2026-11-20', '2026-10-01'), c('HOY', HOY, '2026-10-01')]);
    expect(r.lineas.map((l) => l.lote.id_lote)).toEqual(['HOY']);
  });
  it('RF-06: una tarima por ubicar no es candidata', () => {
    expect(elegibles([c('X', '2026-11-25', '2026-11-01', 0, 10, { id_posicion: null })], HOY)).toHaveLength(0);
  });
});

describe('PU-02 bloqueo con número de tarimas (C1)', () => {
  it('el lote FEFO al fondo sigue siendo la propuesta y declara cuántas tarimas lo bloquean', () => {
    const r = recomendar(5, HOY, [c('FONDO', '2026-11-25', '2026-11-01', 2), c('FRENTE', '2026-12-20', '2026-11-01', 0)]);
    expect(r.lineas[0].lote.id_lote).toBe('FONDO');
    expect(r.lineas[0].bloqueado_por).toBe(2);
    expect(r.lineas[0].tarimas).toEqual(['B0', 'B1']);
  });
});

describe('PU-03 alternativa accesible', () => {
  it('ofrece el primer candidato sin tarimas delante con su diferencia de caducidad', () => {
    const r = recomendar(5, HOY, [c('FONDO', '2026-11-25', '2026-11-01', 2), c('OTRO', '2026-11-27', '2026-11-01', 1), c('FRENTE', '2026-11-30', '2026-11-01', 0)]);
    expect(r.lineas[0].alternativa?.candidato.id_lote).toBe('FRENTE');
    expect(r.lineas[0].alternativa?.dias_de_diferencia).toBe(5);
  });
  it('sin bloqueo no hay alternativa', () => {
    expect(recomendar(5, HOY, [c('A', '2026-11-25', '2026-11-01', 0), c('B', '2026-11-30', '2026-11-01', 0)]).lineas[0].alternativa).toBeNull();
  });
});

describe('PU-04 reparto y faltante', () => {
  it('reparte en orden FEFO respetando las cajas libres y marca el faltante', () => {
    const inv = [c('A', '2026-11-25', '2026-11-01', 0, 4), c('B', '2026-11-28', '2026-11-01', 0, 10)];
    expect(recomendar(7, HOY, inv).lineas.map((l) => [l.lote.id_lote, l.cajas])).toEqual([['A', 4], ['B', 3]]);
    expect(recomendar(20, HOY, inv).faltante).toBe(6);
  });
});

describe('PU-05 (lado motor) definición de conformidad de la base', () => {
  it('es FEFO si ningún lote vigente con saldo caduca estrictamente antes', () => {
    const ex = [{ caducidad_vigente: '2026-11-25', cajas: 5 }, { caducidad_vigente: '2026-11-30', cajas: 5 }, { caducidad_vigente: '2026-11-10', cajas: 9 }];
    expect(esFefo('2026-11-25', ex, HOY)).toBe(true);
    expect(esFefo('2026-11-30', ex, HOY)).toBe(false);
    expect(esFefo('2026-11-30', [{ caducidad_vigente: '2026-11-25', cajas: 0 }], HOY)).toBe(true);
  });
});

describe('PU-06 niveles de U(c) en los límites', () => {
  it('ejemplos de P2 VII.E y catálogo de P3', () => {
    expect(umbral({ vu_dias: 22, vmr_dias: 3, tr_dias: 2, ms_dias: 2 })).toBe(7);
    expect(umbral({ vu_dias: 240, vmr_dias: 30, tr_dias: 5, ms_dias: 5 })).toBe(40);
    expect(umbral({ vu_dias: 20, vmr_dias: 30, tr_dias: 5, ms_dias: 5 })).toBe(20);
  });
  it('cada día límite cae en su nivel y con un día más de margen sale', () => {
    const U = 30;
    expect([-1, 0, 7, 8, 15, 16, 30, 31].map((d) => nivelAlerta(d, U)))
      .toEqual(['vencido', 'critico', 'critico', 'alto', 'alto', 'preventivo', 'preventivo', null]);
    expect(nivelAlerta(7, 7)).toBe('preventivo');
    expect(nivelAlerta(8, 7)).toBeNull();
  });
});

describe('PU-07 criterio por rotación y RN-03', () => {
  it('R < Q/d̄ + VMR + TR', () => {
    expect(riesgoRotacion(10, 40, 4, 0, 2)).toBe(true);
    expect(riesgoRotacion(12, 40, 4, 0, 2)).toBe(false);
    expect(riesgoRotacion(1, 40, 0, 0, 2)).toBe(false);
  });
  it('RN-03: vencido se rechaza, bajo el mínimo pide autorización', () => {
    const base = { hoy: HOY, cajas: 10, demanda: 2, vmr: 3, tr: 2 };
    expect(evaluarRecepcion({ ...base, caducidad: '2026-11-20' }).estado).toBe('rechazar');
    expect(evaluarRecepcion({ ...base, caducidad: '2026-11-28' }).estado).toBe('autorizar');
    expect(evaluarRecepcion({ ...base, caducidad: '2026-11-29' }).estado).toBe('ok');
    expect(evaluarRecepcion({ ...base, demanda: 0, caducidad: '2026-11-26' }).estado).toBe('ok');
  });
});

describe('PU-10 ID de tarima con dígito verificador', () => {
  it('18 dígitos y verificador GS1', () => {
    expect(digitoVerificador('400638133393')).toBe(1);
    const id = idTarima(750123, 1234);
    expect(id).toBe('007501230000012341'.slice(0, 17) + digitoVerificador('00750123000001234'));
    expect(idTarimaValido(id)).toBe(true);
    expect(idTarimaValido(id.slice(0, 17) + ((Number(id[17]) + 1) % 10))).toBe(false);
  });
});
