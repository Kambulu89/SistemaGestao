import { describe, expect, it } from 'vitest';
import { emptyQuoteForm, quotePayload, quoteStatusLabel, quoteTone, zeroRate } from './quote-model';

describe('quote-model', () => {
  it('validade por omissão de 30 dias e uma linha vazia', () => {
    const f = emptyQuoteForm('2026-01-15');
    expect(f.validUntil).toBe('2026-02-14');
    expect(f.lines).toHaveLength(1);
  });

  it('corpo do pedido: vírgulas decimais, vazios como null, entidade só ao criar', () => {
    const f = emptyQuoteForm('2026-01-15');
    f.legalEntityId = 'le';
    f.customerId = 'c';
    f.lines[0] = {
      ...f.lines[0],
      productId: 'p',
      quantity: '2,5',
      manualDiscountPct: '3,5',
      taxRate: '14',
    };
    const created = quotePayload(f, true);
    expect(created.legalEntityId).toBe('le');
    expect('currency' in created).toBe(false);
    expect(created.lines[0]).toEqual({
      productId: 'p',
      description: null,
      quantity: '2.5',
      manualDiscountPct: '3.5',
      manualUnitPrice: null,
      taxRate: '14',
      taxExemptionReason: null,
    });
    expect('legalEntityId' in quotePayload({ ...f, currency: 'usd' }, false)).toBe(false);
    expect(quotePayload({ ...f, currency: 'usd' }, false).currency).toBe('USD');
  });

  it('estado expirado e tons', () => {
    expect(quoteStatusLabel({ status: 'SENT', expired: true })).toBe('Expirado');
    expect(quoteStatusLabel({ status: 'SENT', expired: false })).toBe('Enviado');
    expect(quoteTone({ status: 'ACCEPTED', expired: false })).toContain('success');
    expect(quoteTone({ status: 'SENT', expired: true })).toContain('danger');
    expect(zeroRate('0')).toBe(true);
    expect(zeroRate('0,00')).toBe(true);
    expect(zeroRate('14')).toBe(false);
  });
});
