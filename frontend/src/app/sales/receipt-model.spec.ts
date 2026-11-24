import { describe, expect, it } from 'vitest';
import { minusAmount, receiptTone, sumAmounts } from './receipt-model';

describe('receipt-model', () => {
  it('somas e diferenças exactas sem float', () => {
    expect(sumAmounts(['1100', '300,5', '0.10', ''])).toBe('1400.60');
    expect(sumAmounts(['0.1', '0.2'])).toBe('0.30');
    expect(minusAmount('2000', '1400.60')).toBe('599.40');
    expect(minusAmount('100', '150')).toBe('-50.00');
  });
  it('tons', () => {
    expect(receiptTone('CONFIRMED')).toContain('success');
    expect(receiptTone('PENDING')).toContain('warning');
    expect(receiptTone('REJECTED')).toContain('danger');
  });
});
