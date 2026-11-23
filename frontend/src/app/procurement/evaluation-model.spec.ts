import { describe, expect, it } from 'vitest';
import { defaultPeriod, ratingTone, scoreLabel, weightsSum } from './evaluation-model';

describe('avaliação de fornecedores (modelo)', () => {
  it('período por omissão: do início do ano a hoje', () => {
    expect(defaultPeriod(new Date('2026-11-23T10:00:00Z'))).toEqual({
      from: '2026-01-01',
      to: '2026-11-23',
    });
  });

  it('nota com vírgula; sem provas, traço; soma dos pesos', () => {
    expect(scoreLabel('65.67')).toBe('65,67');
    expect(scoreLabel(null)).toBe('—');
    expect(weightsSum({ quality: 30, delivery: 30, compliance: 20, cost: 20 })).toBe(100);
    expect(weightsSum({ quality: 30, delivery: 30, compliance: 20, cost: Number.NaN })).toBe(80);
  });

  it('cores das classes', () => {
    expect(ratingTone('A')).toContain('success');
    expect(ratingTone('C')).toContain('warning');
    expect(ratingTone('D')).toContain('danger');
    expect(ratingTone(null)).toContain('muted');
  });
});
