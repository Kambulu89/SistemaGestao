import { describe, expect, it } from 'vitest';
import { emptyInvoiceLine, invoiceLinesPayload, invoiceTone, selectedCodes } from './invoice-model';

describe('invoice-model', () => {
  it('linhas: impostos escolhidos, vírgulas decimais e vazios como null', () => {
    const l = {
      ...emptyInvoiceLine(),
      productId: 'p',
      quantity: '1,5',
      taxCodes: { a: true, b: false, c: true },
      exemptionCode: ' ',
    };
    expect(selectedCodes(l.taxCodes)).toEqual(['a', 'c']);
    expect(invoiceLinesPayload([l])[0]).toEqual({
      productId: 'p',
      description: null,
      quantity: '1.5',
      manualDiscountPct: null,
      manualUnitPrice: null,
      taxCodeIds: ['a', 'c'],
      exemptionCode: null,
    });
  });
  it('tons dos três estados', () => {
    expect(invoiceTone('ISSUED')).toContain('success');
    expect(invoiceTone('PENDING')).toContain('warning');
    expect(invoiceTone('OVERDUE')).toContain('danger');
    expect(invoiceTone(null)).toContain('muted');
  });
});
