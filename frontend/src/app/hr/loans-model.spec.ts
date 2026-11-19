import { describe, expect, it } from 'vitest';
import {
  installmentPreview,
  installmentTone,
  loanTone,
  periodLabel,
  settledPercent,
} from './loans-model';

describe('adiantamentos e empréstimos (modelo)', () => {
  it('mês em texto', () => {
    expect(periodLabel('2026-11-01')).toBe('novembro de 2026');
    expect(periodLabel('2027-01')).toBe('janeiro de 2027');
    expect(periodLabel('x')).toBe('x');
  });

  it('prestação prevista como no servidor (resto na última)', () => {
    expect(installmentPreview('100000.00', 3)).toEqual({ regular: '33333.33', last: '33333.34' });
    expect(installmentPreview('50000', 1)).toEqual({ regular: '50000.00', last: '50000.00' });
    expect(installmentPreview('0.02', 3)).toBeNull();
    expect(installmentPreview('abc', 3)).toBeNull();
    expect(installmentPreview(null, 3)).toBeNull();
    expect(installmentPreview('100', 0)).toBeNull();
  });

  it('progresso e tons', () => {
    expect(settledPercent({ principal: '90000.00', paidAmount: '30000.00' })).toBe(33);
    expect(settledPercent({ principal: '90000.00', paidAmount: '90000.00' })).toBe(100);
    expect(loanTone('ACTIVE')).toContain('info');
    expect(loanTone('CANCELLED')).toContain('muted');
    expect(installmentTone('PAID')).toContain('success');
    expect(installmentTone('PENDING')).toContain('warning');
  });
});
