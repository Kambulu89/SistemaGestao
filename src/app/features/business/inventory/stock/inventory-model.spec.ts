import { describe, expect, it } from 'vitest';
import {
  adjustmentIssue,
  inventoryError,
  isSignedQuantity,
  sourceLabel,
  trimQuantity,
} from './inventory-model';

const ok = {
  quantityDelta: '5',
  unitCost: '',
  reason: 'Contagem',
  hasVariant: true,
  needsLot: false,
  lotId: '',
  locationId: 'l1',
};

describe('inventory-model', () => {
  it('quantidades são decimais exactos com sinal', () => {
    expect(isSignedQuantity('-2.5')).toBe(true);
    expect(isSignedQuantity('1.1234567')).toBe(false);
    expect(isSignedQuantity('1e3')).toBe(false);
    expect(isSignedQuantity('')).toBe(false);
  });

  it('trimQuantity só tira zeros à direita', () => {
    expect(trimQuantity('10.500000')).toBe('10.5');
    expect(trimQuantity('3.000000')).toBe('3');
    expect(trimQuantity('100')).toBe('100');
    expect(trimQuantity('-0.000000')).toBe('0');
    expect(trimQuantity('0.000001')).toBe('0.000001');
  });

  it('valida o ajuste por ordem', () => {
    expect(adjustmentIssue(ok)).toBeNull();
    expect(adjustmentIssue({ ...ok, hasVariant: false })).toContain('SKU');
    expect(adjustmentIssue({ ...ok, locationId: '' })).toContain('local');
    expect(adjustmentIssue({ ...ok, needsLot: true })).toContain('lote');
    expect(adjustmentIssue({ ...ok, needsLot: true, lotId: 'x' })).toBeNull();
    expect(adjustmentIssue({ ...ok, quantityDelta: '0' })).toContain('diferente de zero');
    expect(adjustmentIssue({ ...ok, quantityDelta: '0.000000' })).toContain('diferente de zero');
    expect(adjustmentIssue({ ...ok, unitCost: '-1' })).toContain('Custo');
    expect(adjustmentIssue({ ...ok, reason: ' ' })).toContain('motivo');
  });

  it('origens conhecidas têm nome; as outras mantêm-se', () => {
    expect(sourceLabel('SALES_ORDER')).toBe('Encomenda de venda');
    expect(sourceLabel('OUTRA')).toBe('OUTRA');
  });

  it('junta a frase ao «Disponível» do servidor sem a repetir', () => {
    const detail = {
      code: 'INSUFFICIENT_STOCK',
      message: 'Stock disponível insuficiente.',
      fieldErrors: [
        { path: 'quantityDelta', code: 'INSUFFICIENT_STOCK', message: 'Disponível: 7.000000.' },
      ],
    };
    expect(inventoryError(detail, 'x')).toBe(
      'Stock disponível insuficiente. Disponível: 7.000000.',
    );
    expect(
      inventoryError(
        { code: 'INSUFFICIENT_STOCK', message: 'Stock disponível insuficiente.' },
        'x',
      ),
    ).toBe('Stock disponível insuficiente.');
    expect(inventoryError({ code: 'NOT_FOUND', message: 'Recurso não encontrado.' }, 'x')).toBe(
      'Recurso não encontrado.',
    );
  });
});
