import { describe, expect, it } from 'vitest';
import {
  contractTypeLabel,
  initiativeLabel,
  payrollCsvRows,
  pctLabel,
  reasonLabel,
  shortMonth,
  type PayrollReport,
  topBars,
} from './portal-model';

describe('modelo dos portais e relatórios', () => {
  it('rótulos', () => {
    expect(shortMonth('2026-03')).toBe('mar 2026');
    expect(pctLabel('12.50')).toBe('12,50 %');
    expect(pctLabel(null)).toBe('—');
    expect(contractTypeLabel(null)).toBe('Sem contrato');
    expect(reasonLabel('RESIGNATION')).toBe('Denúncia pelo trabalhador');
    expect(initiativeLabel('EMPLOYER')).toBe('Da empresa');
  });

  it('linhas CSV da folha com totais', () => {
    const f = {
      currency: 'AOA',
      employees: 2,
      gross: '400000.00',
      inssEmployee: '12000.00',
      inssEmployer: '32000.00',
      irt: '18800.00',
      deductions: '0.00',
      loans: '0.00',
      net: '369200.00',
      employerCost: '432000.00',
    };
    const r = {
      year: 2026,
      legalEntities: [],
      months: [{ ...f, month: '2026-01' }],
      byKind: [],
      byDepartment: [],
      totals: [f],
    } as PayrollReport;
    const csv = payrollCsvRows(r);
    expect(csv.headers[3]).toBe('Bruto');
    expect(csv.rows).toHaveLength(2);
    expect(csv.rows[1][0]).toBe('Total 2026');
    expect(csv.rows[0][3]).toBe('400000.00');
  });

  it('agrupa as barras a mais em "Outros"', () => {
    const g = Array.from({ length: 10 }, (_, i) => ({ label: `D${i}`, count: i + 1 }));
    const bars = topBars(g);
    expect(bars).toHaveLength(8);
    expect(bars[0]).toEqual({ label: 'D9', value: 10 });
    expect(bars[7]).toEqual({ label: 'Outros', value: 1 + 2 + 3 });
    expect(topBars(g.slice(0, 3))).toHaveLength(3);
  });
});
