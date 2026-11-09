import { describe, expect, it } from 'vitest';
import { bracketsPayload, monthName, nextStep, pct, runTitle, runTone } from './payroll-model';

describe('processamento salarial (modelo)', () => {
  it('títulos e meses', () => {
    expect(monthName('2026-11-01')).toBe('novembro de 2026');
    expect(runTitle({ kind: 'REGULAR', period: '2026-11-01', targetPeriod: null })).toBe(
      'Regular · novembro de 2026',
    );
    expect(runTitle({ kind: 'RETRO', period: '2026-10-01', targetPeriod: '2026-09-01' })).toBe(
      'Retroactivo de setembro de 2026 (em outubro de 2026)',
    );
    expect(pct('3.0000')).toBe('3');
    expect(pct('6.5000')).toBe('6,5');
  });

  it('próximo passo e tom pelo estado', () => {
    expect(nextStep({ status: 'CALCULATED', errorsCount: 2, employeesCount: 5 })).toContain(
      '2 colaborador(es) com erros',
    );
    expect(nextStep({ status: 'CALCULATED', errorsCount: 0, employeesCount: 5 })).toContain(
      'Peça aprovação',
    );
    expect(nextStep({ status: 'CLOSED', errorsCount: 0, employeesCount: 5 })).toContain(
      'retroactivo',
    );
    expect(runTone('CLOSED')).toContain('success');
    expect(runTone('DRAFT')).toContain('muted');
  });

  it('escalões do formulário', () => {
    expect(
      bracketsPayload([
        { lower: '0', upper: '100 000', fixedAmount: '', rate: '0', excessOver: '' },
        { lower: '100000,01', upper: '', fixedAmount: '0', rate: '10', excessOver: '100000' },
      ]),
    ).toEqual([
      { lower: '0', upper: '100000', fixedAmount: '0', rate: '0', excessOver: '0' },
      { lower: '100000.01', upper: null, fixedAmount: '0', rate: '10', excessOver: '100000' },
    ]);
  });
});
