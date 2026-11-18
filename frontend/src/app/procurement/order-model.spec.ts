import { describe, expect, it } from 'vitest';
import {
  approvalTone,
  emptyOrderLine,
  orderGrandTotal,
  orderLinePayload,
  orderLineTotals,
  progressTone,
} from './order-model';

describe('ordens de compra (9.5)', () => {
  it('valores da linha com desconto e imposto, como no servidor', () => {
    expect(orderLineTotals('6', '1000', '10', '14')).toEqual({ net: '5400.00', total: '6156.00' });
    expect(orderLineTotals('3', '0,333333', '2,5', '14')).toEqual({ net: '0.97', total: '1.11' });
    expect(orderLineTotals('1', '', '0', '0')).toBeNull();
    expect(orderLineTotals('1', '1', '101', '0')).toBeNull();
  });

  it('total geral e corpo da linha', () => {
    const a = {
      ...emptyOrderLine(),
      quantity: '6',
      unitPrice: '1000',
      discountRate: '10',
      taxRate: '14',
    };
    const b = { ...emptyOrderLine(), description: 'Transporte', unitPrice: '5000' };
    expect(orderGrandTotal([a, b])).toBe('11156.00');
    expect(orderGrandTotal([a, { ...b, unitPrice: '' }])).toBeNull();
    expect(
      orderLinePayload({ ...b, description: ' Transporte ', discountRate: '', taxRate: '' }),
    ).toEqual({
      id: null,
      requisitionLineId: null,
      productId: null,
      description: 'Transporte',
      uomId: null,
      quantity: '1',
      unitPrice: '5000',
      discountRate: '0',
      taxRate: '0',
      expectedDate: null,
    });
  });

  it('cores dos estados', () => {
    expect(approvalTone('APPROVED')).toContain('success');
    expect(progressTone('PARTIALLY_RECEIVED')).toContain('warning');
    expect(progressTone('NOT_INVOICED')).toContain('muted');
  });
});
