import { describe, expect, it } from 'vitest';
import { emptyLine, linePayload, lineTotal, requisitionTone } from './requisition-model';

describe('requisições de compra (9.2)', () => {
  it('total da linha com o arredondamento do servidor', () => {
    expect(lineTotal('10', '1000', '14')).toBe('11400.00');
    expect(lineTotal('3', '0,333333', '6.5')).toBe('1.07');
    expect(lineTotal('1', '', '')).toBe('0.00');
    expect(lineTotal('x', '1', '0')).toBeNull();
    expect(lineTotal('1', '1.0000001', '0')).toBeNull();
  });

  it('corpo da linha e cores do estado', () => {
    expect(
      linePayload({
        ...emptyLine(),
        description: ' Papel ',
        quantity: '2,5',
        estimatedUnitPrice: '',
      }),
    ).toEqual({
      productId: null,
      description: 'Papel',
      uomId: null,
      quantity: '2.5',
      estimatedUnitPrice: '0',
      taxRate: '0',
      neededBy: null,
      suggestedSupplierId: null,
    });
    expect(requisitionTone('APPROVED')).toContain('success');
    expect(requisitionTone('REJECTED')).toContain('danger');
    expect(requisitionTone('PENDING_APPROVAL')).toContain('warning');
  });
});
