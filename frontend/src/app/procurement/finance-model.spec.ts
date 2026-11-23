import { describe, expect, it } from 'vitest';
import { accountingTone, nonZeroAmounts, payableTone, usedPercent } from './finance-model';

describe('orçamento e obrigações (modelo)', () => {
  it('montantes diferentes de zero com nome legível, pela ordem conhecida', () => {
    expect(
      nonZeroAmounts({
        payable: '8366.00',
        goodsReceived: '6600.00',
        priceVarianceDown: '0.00',
        tax: '966.00',
        other: '5.00',
      }),
    ).toEqual([
      { label: 'Recepções por facturar', value: '6600.00' },
      { label: 'Imposto', value: '966.00' },
      { label: 'Fornecedor', value: '8366.00' },
    ]);
  });

  it('percentagem usada da verba, limitada', () => {
    expect(usedPercent({ amount: '15000.00', available: '4400.00' })).toBe(71);
    expect(usedPercent({ amount: '15000.00', available: '-900.00' })).toBe(100);
    expect(usedPercent({ amount: '0.00', available: '0.00' })).toBe(100);
    expect(usedPercent({ amount: '100.00', available: '100.00' })).toBe(0);
  });

  it('cores: saldada, em atraso, em parte; contabilização', () => {
    expect(payableTone('SETTLED', true)).toContain('success');
    expect(payableTone('OPEN', true)).toContain('danger');
    expect(payableTone('PARTIALLY_PAID')).toContain('warning');
    expect(payableTone('OPEN')).toContain('muted');
    expect(accountingTone('FAILED')).toContain('danger');
    expect(accountingTone('POSTED')).toContain('success');
  });
});
