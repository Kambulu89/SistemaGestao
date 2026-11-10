import { describe, expect, it } from 'vitest';
import {
  isZero,
  newKey,
  productLabel,
  qty,
  signedQty,
  sourceLabel,
  type StockBalance,
  statusQuantityError,
} from './stock-model';

const row = (over: Partial<StockBalance> = {}): StockBalance => ({
  id: 'b1',
  version: 1,
  warehouse: { id: 'w', code: 'WA', name: 'Central' },
  location: { id: 'l', pathCode: 'Z1-C1' },
  product: { id: 'p', sku: 'AGUA', name: 'Água' },
  variant: null,
  uom: 'UN',
  uomDecimals: 0,
  physical: '1250.500000',
  available: '1200.000000',
  unrestricted: '1230.000000',
  blocked: '0.000000',
  quarantine: '20.500000',
  reserved: '30.000000',
  inTransit: '0.000000',
  expected: '0.000000',
  lastMovementAt: null,
  ...over,
});

describe('stock-model', () => {
  it('formata quantidades exactas sem zeros à direita', () => {
    expect(qty('1250.500000')).toBe('1 250,5');
    expect(qty('-3.000000')).toBe('−3');
    expect(qty('0.000000')).toBe('0');
    expect(qty(null)).toBe('—');
    expect(signedQty('2.000000')).toBe('+2');
    expect(signedQty('-2.250000')).toBe('−2,25');
    expect(isZero('0.000000')).toBe(true);
    expect(isZero('-0.000001')).toBe(false);
  });

  it('valida a quantidade de uma mudança de estado', () => {
    expect(statusQuantityError('5', '10', 0)).toBeNull();
    expect(statusQuantityError('1,5', '10', 3)).toBeNull();
    expect(statusQuantityError('1.5', '10', 0)).toContain('inteira');
    expect(statusQuantityError('0', '10')).toContain('positiva');
    expect(statusQuantityError('11', '10.000000', 0)).toContain('Há só 10');
  });

  it('identifica a variante e gera chaves novas', () => {
    expect(productLabel(row())).toBe('AGUA');
    expect(productLabel(row({ variant: { id: 'v', sku: 'AGUA-1L' } }))).toBe('AGUA-1L');
    const a = newKey('st');
    expect(a).toMatch(/^st-.{8,}/);
    expect(newKey('st')).not.toBe(a);
    expect(sourceLabel({ type: 'STOCK_STATUS', ref: null })).toContain('mudança de estado');
    expect(sourceLabel({ type: 'X', ref: 'GR 1' })).toBe('GR 1');
  });
});
