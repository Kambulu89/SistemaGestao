import { describe, expect, it } from 'vitest';
import { daysLabel, fitsBalance, leaveTone } from './leave-model';

describe('férias e ausências (modelo)', () => {
  it('dias para leitura sem zeros inúteis e com vírgula', () => {
    expect(daysLabel('4.00')).toBe('4');
    expect(daysLabel('16.50')).toBe('16,5');
    expect(daysLabel('20.17')).toBe('20,17');
    expect(daysLabel('0.00')).toBe('0');
    expect(daysLabel('-1.50')).toBe('-1,5');
    expect(daysLabel(null)).toBe('—');
  });

  it('cabe no saldo: comparação exacta, incluindo saldos negativos', () => {
    expect(fitsBalance('4.00', '4.00')).toBe(true);
    expect(fitsBalance('4.01', '4.00')).toBe(false);
    expect(fitsBalance('0.50', '-1.00')).toBe(false);
    expect(fitsBalance('10', '29.5')).toBe(true);
  });

  it('cores só de tokens semânticos por estado', () => {
    expect(leaveTone('APPROVED')).toContain('success');
    expect(leaveTone('PENDING')).toContain('warning');
    expect(leaveTone('REJECTED')).toContain('danger');
    expect(leaveTone('CANCELLED')).toContain('muted');
  });
});
