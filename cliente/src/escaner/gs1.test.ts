import { describe, expect, it } from 'vitest';
import { clasificar, leerGs1 } from './gs1.js';

describe('PU-09 lector GS1-128 (AI 01, 10, 17)', () => {
  it('lee la forma legible y la cruda con separador y prefijo de simbología', () => {
    expect(leerGs1('(01)07501234567890(17)261128(10)L2611A')).toEqual({ gtin: '07501234567890', lote: 'L2611A', caducidad: '2026-11-28', fuenteFecha: '17' });
    expect(leerGs1(']C1010750123456789010L2611A\x1d17261100')).toEqual({ gtin: '07501234567890', lote: 'L2611A', caducidad: '2026-11-30', fuenteFecha: '17' });
    expect(leerGs1('(01)07501234567890(15)270131')?.fuenteFecha).toBe('15');
    expect(leerGs1('B-F07-D3')).toBeNull();
  });
  it('clasifica tarima, posiciones RN-04 (rack, piso, cámara), caja y texto', () => {
    expect(clasificar('007501230000012341').tipo).toBe('tarima');
    expect(clasificar('a-p01-r02-n3')).toEqual({ tipo: 'posicion', valor: 'A-P01-R02-N3' });
    expect(clasificar('B-F07-D3').tipo).toBe('posicion');
    expect(clasificar('C-R01-N1').tipo).toBe('posicion');
    expect(clasificar('(01)07501234567890(10)X').tipo).toBe('gs1');
    expect(clasificar('leche').tipo).toBe('texto');
  });
});
