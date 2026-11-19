import { describe, expect, it } from 'vitest';
import {
  caseTone,
  enrollmentTone,
  levelDots,
  needsDefence,
  resultOptions,
  sessionTone,
} from './training-model';

describe('formação e processos (modelo)', () => {
  it('resultados conforme a avaliação do curso', () => {
    expect(resultOptions(true)).toContain('PASSED');
    expect(resultOptions(true)).not.toContain('ATTENDED');
    expect(resultOptions(false)).toEqual(['ATTENDED', 'NO_SHOW', 'CANCELLED']);
  });

  it('sanção exige defesa ou audiência registada', () => {
    expect(needsDefence('NO_ACTION', [])).toBe(false);
    expect(needsDefence('WRITTEN_WARNING', [{ kind: 'NOTE' }])).toBe(true);
    expect(needsDefence('WRITTEN_WARNING', [{ kind: 'HEARING' }])).toBe(false);
  });

  it('níveis e tons', () => {
    expect(levelDots(3)).toBe('●●●○○');
    expect(levelDots(9)).toBe('●●●●●');
    expect(sessionTone('COMPLETED')).toContain('success');
    expect(enrollmentTone('FAILED')).toContain('danger');
    expect(caseTone('UNDER_REVIEW')).toContain('warning');
  });
});
