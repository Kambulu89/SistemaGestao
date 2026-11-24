import { describe, expect, it } from 'vitest';
import { fiscalTone, ratePct, SIMULATION_NOTICE } from './fiscal-model';

describe('fiscal-model', () => {
  it('taxa legível sem float', () => {
    expect(ratePct('14.0000')).toBe('14 %');
    expect(ratePct('6.5000')).toBe('6,5 %');
    expect(ratePct('0.0000')).toBe('0 %');
  });
  it('tons e aviso de simulação', () => {
    expect(fiscalTone('CONFIRMED')).toContain('success');
    expect(fiscalTone('DRAFT')).toContain('warning');
    expect(fiscalTone('RETIRED')).toContain('muted');
    expect(SIMULATION_NOTICE).toMatch(/não está certificado/);
  });
});
