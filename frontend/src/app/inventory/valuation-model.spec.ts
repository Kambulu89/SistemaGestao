import { describe, expect, it } from 'vitest';
import { isZeroMoney, money, sumMoney } from './valuation-model';

describe('valorização (8.9)', () => {
  it('dinheiro sem vírgula flutuante', () => {
    expect(money('1234567.5')).toBe('1 234 567,50');
    expect(money('-405.00', 'AOA')).toBe('−405,00 AOA');
    expect(money(null)).toBe('—');
    expect(sumMoney(['0.10', '0.20', '-0.05'])).toBe('0.25');
    expect(sumMoney(['33.33', '33.34', '33.33'])).toBe('100.00');
    expect(sumMoney(['-1.00', '0.50'])).toBe('-0.50');
    expect(isZeroMoney('0.00')).toBe(true);
    expect(isZeroMoney('-0.01')).toBe(false);
  });
});
