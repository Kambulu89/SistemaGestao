import { describe, expect, it } from 'vitest';
import {
  consumedPct,
  contractTone,
  emptyPrice,
  emptySla,
  pricePayload,
  priceForm,
  slaPayload,
} from './contract-model';

describe('contratos (9.6)', () => {
  it('percentagem consumida inteira e limitada', () => {
    expect(consumedPct('6000.00', '10000.00')).toBe(60);
    expect(consumedPct('0.00', '10000.00')).toBe(0);
    expect(consumedPct('3333.33', '10000.00')).toBe(33);
    expect(consumedPct('1', '0')).toBe(0);
  });

  it('corpos de preço e SLA', () => {
    expect(pricePayload({ ...emptyPrice(), description: ' Cabo ', unitPrice: '1,5' })).toEqual({
      productId: null,
      description: 'Cabo',
      uomId: null,
      unitPrice: '1.5',
    });
    expect(slaPayload({ ...emptySla(), target: '7', penalty: ' 1% ' })).toEqual({
      metric: 'DELIVERY_DAYS',
      target: '7',
      description: null,
      penalty: '1%',
    });
    expect(
      priceForm({
        id: 'x',
        lineNo: 1,
        product: { id: 'p', sku: 'S' },
        variantId: null,
        description: 'D',
        uom: null,
        unitPrice: '950.000000',
        notes: null,
      }),
    ).toEqual({ productId: 'p', description: 'D', uomId: '', unitPrice: '950' });
  });

  it('cores do estado efectivo', () => {
    expect(contractTone('ACTIVE')).toContain('success');
    expect(contractTone('EXPIRED')).toContain('danger');
    expect(contractTone('NOT_STARTED')).toContain('warning');
  });
});
