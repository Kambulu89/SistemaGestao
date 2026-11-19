import { describe, expect, it } from 'vitest';
import {
  checklistProgress,
  isEarning,
  lineAmount,
  nextStep,
  scaled,
  serviceLabel,
  type Termination,
  terminationTone,
} from './termination-model';

describe('modelo da cessação', () => {
  it('calcula quantidade × valor unitário sem float', () => {
    expect(lineAmount('10', '6666.6667')).toBe('66666.67');
    expect(lineAmount('0.01', '0.5')).toBe('0.01');
    expect(lineAmount('1,5', '1000')).toBe('1500.00');
    expect(lineAmount('', '1')).toBeNull();
    expect(lineAmount('1', '1.23456')).toBeNull();
    expect(scaled('12.3', 2)).toBe(1230n);
  });

  it('descreve a antiguidade', () => {
    expect(serviceLabel({ years: 3, months: 2, days: 5, totalDays: 0 })).toBe(
      '3 anos, 2 meses e 5 dias',
    );
    expect(serviceLabel({ years: 1, months: 0, days: 0, totalDays: 0 })).toBe('1 ano');
    expect(serviceLabel({ years: 0, months: 1, days: 1, totalDays: 0 })).toBe('1 mês e 1 dia');
    expect(serviceLabel({ years: 0, months: 0, days: 0, totalDays: 0 })).toBe('0 dias');
  });

  it('distingue abonos de descontos e tons por estado', () => {
    expect(isEarning('INDEMNITY')).toBe(true);
    expect(isEarning('NOTICE_DEDUCTION')).toBe(false);
    expect(terminationTone('SETTLED')).toContain('success');
    expect(terminationTone('DRAFT')).not.toMatch(/bg-(red|green|blue)-/);
  });

  it('progresso da checklist e próximo passo', () => {
    const task = (status: 'PENDING' | 'DONE' | 'NOT_APPLICABLE') => ({
      id: status,
      version: 1,
      category: 'OTHER' as const,
      kind: 'MANUAL' as const,
      title: 'x',
      status,
      notes: null,
      completedBy: null,
      completedAt: null,
    });
    expect(checklistProgress([task('PENDING'), task('DONE'), task('NOT_APPLICABLE')])).toEqual({
      done: 2,
      total: 3,
    });
    const base = { status: 'APPROVED', lines: [{}], settlementRun: null } as unknown as Termination;
    expect(nextStep(base)).toContain('Gere o lote');
    expect(
      nextStep({ ...base, settlementRun: { id: 'r', code: 'PS-1', status: 'CALCULATED' } }),
    ).toContain('PS-1');
    expect(
      nextStep({ ...base, settlementRun: { id: 'r', code: 'PS-1', status: 'CLOSED' } }),
    ).toContain('checklist');
    expect(
      nextStep({ ...base, status: 'DRAFT', blockers: [{ path: '', code: '', message: '' }] }),
    ).toContain('impedimentos');
  });
});
