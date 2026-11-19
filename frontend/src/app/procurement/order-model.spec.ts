import { describe, expect, it } from 'vitest';
import {
  approvalTone,
  contractPrice,
  contractsFor,
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

  it('contratos que servem a ordem e preço acordado', () => {
    const c = {
      id: 'c1',
      number: 'CT-1',
      title: 'T',
      legalEntityId: 'le',
      supplierId: 's',
      currency: 'AOA',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      remaining: '100.00',
      prices: [
        { productId: 'p', variantId: null, unitPrice: '950.000000' },
        { productId: 'q', variantId: 'v', unitPrice: '1.000000' },
      ],
    };
    expect(contractsFor([c], { legalEntityId: 'le', supplierId: 's', currency: '' })).toHaveLength(
      1,
    );
    expect(
      contractsFor([c], { legalEntityId: 'le', supplierId: 's', currency: 'usd' }),
    ).toHaveLength(0);
    expect(
      contractsFor([c], { legalEntityId: 'le', supplierId: 'x', currency: 'AOA' }),
    ).toHaveLength(0);
    expect(contractPrice(c, 'p')).toBe('950.000000');
    expect(contractPrice(c, 'q')).toBeNull();
    expect(contractPrice(undefined, 'p')).toBeNull();
  });
});
