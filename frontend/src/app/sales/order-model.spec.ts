import { describe, expect, it } from 'vitest';
import { emptyOrderForm, orderPayload, orderTone, subTone } from './order-model';

describe('order-model', () => {
  it('corpo do pedido: com linhas ao criar; sem linhas nem cliente numa encomenda vinda de orçamento', () => {
    const f = emptyOrderForm('2026-01-15');
    f.legalEntityId = 'le';
    f.customerId = 'c';
    f.warehouseId = 'w';
    f.lines[0] = { ...f.lines[0], productId: 'p', quantity: '2,5', taxRate: '14' };
    const created = orderPayload(f, true, true);
    expect(created.legalEntityId).toBe('le');
    expect(created.warehouseId).toBe('w');
    expect(created.requestedDate).toBeNull();
    expect(created.lines?.[0].quantity).toBe('2.5');
    const fromQuote = orderPayload(f, false, false);
    expect('lines' in fromQuote).toBe(false);
    expect('customerId' in fromQuote).toBe(false);
    expect('legalEntityId' in fromQuote).toBe(false);
  });

  it('tons dos estados', () => {
    expect(orderTone('CONFIRMED')).toContain('primary');
    expect(subTone('FULL')).toContain('success');
    expect(subTone('PARTIAL')).toContain('warning');
    expect(subTone('REJECTED')).toContain('danger');
  });
});
