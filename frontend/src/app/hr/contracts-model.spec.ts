import { describe, expect, it } from 'vitest';
import { amendmentSummary, contractActions, contractPayload, periodLabel } from './contracts-model';

describe('contratos e carreira (modelo)', () => {
  it('acções por estado: renovar só a termo certo; sem gestão nada', () => {
    expect(contractActions({ status: 'DRAFT', contractType: 'PERMANENT' }, true)).toEqual([
      'edit',
      'activate',
      'cancel',
    ]);
    expect(contractActions({ status: 'ACTIVE', contractType: 'FIXED_TERM' }, true)).toEqual([
      'amend',
      'renew',
      'suspend',
      'terminate',
    ]);
    expect(contractActions({ status: 'ACTIVE', contractType: 'PERMANENT' }, true)).toEqual([
      'amend',
      'suspend',
      'terminate',
    ]);
    expect(contractActions({ status: 'SUSPENDED', contractType: 'FIXED_TERM' }, true)).toEqual([
      'amend',
      'resume',
      'terminate',
    ]);
    expect(contractActions({ status: 'ENDED', contractType: 'FIXED_TERM' }, true)).toEqual([]);
    expect(contractActions({ status: 'ACTIVE', contractType: 'FIXED_TERM' }, false)).toEqual([]);
  });

  it('período e resumo de adenda em texto', () => {
    const d = (v: string) => v.split('-').reverse().join('/');
    expect(periodLabel({ validFrom: '2026-01-05', validTo: null }, d)).toBe('desde 05/01/2026');
    expect(periodLabel({ validFrom: '2026-01-05', validTo: '2026-03-31' }, d)).toBe(
      '05/01/2026 – 31/03/2026',
    );
    expect(
      amendmentSummary(
        {
          baseSalary: '300000.00',
          weeklyHours: '37.50',
          workSchedule: null,
          endDate: '2027-01-04',
        },
        'AOA',
        (v) => v,
        d,
      ),
    ).toBe('remuneração 300000.00 AOA · 37.50 h/semana · termo 04/01/2027');
  });

  it('pedido: vazios fora na criação; na edição só o que mudou; números em texto', () => {
    expect(
      contractPayload({ code: ' CT ', weeklyHours: 40, endDate: '', baseSalary: '1000' }, null),
    ).toEqual({ code: 'CT', weeklyHours: '40', baseSalary: '1000' });
    expect(
      contractPayload(
        { code: 'CT', notes: '', baseSalary: '1000.00' },
        { code: 'CT', notes: 'x', baseSalary: '1000.00' },
      ),
    ).toEqual({ notes: null });
  });
});
