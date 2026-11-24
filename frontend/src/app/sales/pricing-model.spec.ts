import { describe, expect, it } from 'vitest';
import {
  emptyListForm,
  listPayload,
  percent,
  period,
  price,
  pricingTone,
  qty,
  ruleScope,
  targetLabel,
} from './pricing-model';

describe('pricing-model', () => {
  it('formata percentagens, quantidades e preços sem float', () => {
    expect(percent('5.00')).toBe('5 %');
    expect(percent('2.50')).toBe('2,5 %');
    expect(percent(null)).toBe('—');
    expect(qty('10.000000')).toBe('10');
    expect(qty('0.500000')).toBe('0,5');
    expect(price('1500000.0000', 'AOA')).toBe('1 500 000,00 AOA');
    expect(price('0.3333')).toBe('0,3333');
    expect(price('12.5000')).toBe('12,50');
    expect(period('2026-01-01', null)).toBe('desde 2026-01-01');
  });

  it('destino e tom do estado', () => {
    expect(targetLabel({ targetType: 'GENERAL', segment: null, customer: null })).toBe('Geral');
    expect(targetLabel({ targetType: 'ALL', segment: null, customer: null })).toBe(
      'Todos os clientes',
    );
    expect(
      targetLabel({
        targetType: 'CUSTOMER',
        segment: null,
        customer: { id: '1', code: 'C1', name: 'Cliente' },
      }),
    ).toBe('Cliente C1 — Cliente');
    expect(pricingTone('ACTIVE')).toContain('success');
    expect(pricingTone('PENDING')).toContain('warning');
    expect(ruleScope({ product: null, category: null, minQuantity: '0.000000' })).toBe(
      'Todos os produtos',
    );
    expect(
      ruleScope({
        product: { id: '1', sku: 'P1', name: 'x' },
        category: null,
        minQuantity: '12.500000',
      }),
    ).toBe('Produto P1 · a partir de 12,5');
  });

  it('corpo do pedido: destino coerente, vazios como null e código só ao criar', () => {
    const f = {
      ...emptyListForm('2026-01-01'),
      code: ' g1 ',
      name: ' Geral ',
      segmentId: 'x',
      currency: 'aoa',
    };
    const created = listPayload(f, true);
    expect(created.code).toBe('g1');
    expect(created.segmentId).toBeNull();
    expect(created.validTo).toBeNull();
    expect(created.currency).toBe('AOA');
    expect(created.priority).toBe(100);
    const edited = listPayload({ ...f, targetType: 'SEGMENT' }, false);
    expect('code' in edited).toBe(false);
    expect(edited.segmentId).toBe('x');
  });
});
