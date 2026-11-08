import { describe, expect, it } from 'vitest';
import { incidenceLabel, lineValue, linesPayload, proposalTone } from './compensation-model';

const money = (v: string) => v;

describe('compensação (modelo)', () => {
  it('incidência em texto', () => {
    expect(incidenceLabel(null, money)).toBe('Incidência por definir');
    expect(
      incidenceLabel(
        {
          validFrom: '2026-01-01',
          irtSubject: true,
          irtExemptAmount: '30000.00',
          inssSubject: false,
        },
        money,
      ),
    ).toBe('IRT (isento até 30000.00)');
    expect(
      incidenceLabel(
        { validFrom: '2026-01-01', irtSubject: true, irtExemptAmount: null, inssSubject: true },
        money,
      ),
    ).toBe('IRT · INSS');
    expect(
      incidenceLabel(
        { validFrom: '2026-01-01', irtSubject: false, irtExemptAmount: null, inssSubject: false },
        money,
      ),
    ).toBe('Sem IRT nem INSS');
  });

  it('valor da linha: remover, percentagem sem zeros, montante', () => {
    expect(lineValue({ action: 'REMOVE', amount: null, percent: null }, money)).toBe('Remover');
    expect(lineValue({ action: 'SET', amount: null, percent: '10.0000' }, money)).toBe(
      '10% do salário base',
    );
    expect(lineValue({ action: 'SET', amount: null, percent: '7.5000' }, money)).toBe(
      '7.5% do salário base',
    );
    expect(lineValue({ action: 'SET', amount: '25000.00', percent: null }, money)).toBe('25000.00');
  });

  it('linhas para a API: só o valor do cálculo do componente, vírgula decimal aceite', () => {
    const calc = (id: string) => (id === 'p' ? 'PERCENT_OF_BASE' : 'FIXED') as never;
    expect(
      linesPayload(
        [
          { componentId: 'f', action: 'SET', value: '25000,5' },
          { componentId: 'p', action: 'SET', value: '10' },
          { componentId: 'r', action: 'REMOVE', value: '99' },
          { componentId: null, action: 'SET', value: '1' },
        ],
        calc,
      ),
    ).toEqual([
      { componentId: 'f', action: 'SET', amount: '25000.5' },
      { componentId: 'p', action: 'SET', percent: '10' },
      { componentId: 'r', action: 'REMOVE' },
    ]);
  });

  it('cores por estado (tokens semânticos)', () => {
    expect(proposalTone('APPLIED')).toContain('success');
    expect(proposalTone('PENDING_APPROVAL')).toContain('warning');
    expect(proposalTone('REJECTED')).toContain('danger');
  });
});
