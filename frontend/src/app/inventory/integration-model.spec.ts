import { describe, expect, it } from 'vitest';
import { accountingTone, eventClasses } from './integration-model';

describe('integrações (8.10)', () => {
  it('classes com valor e cor do estado', () => {
    expect(
      eventClasses({
        value: '10.00',
        cls_mercadorias: '10.00',
        cls_materias: '0.00',
        cls_sem_classe: '0.00',
      }),
    ).toEqual(['MERCADORIAS']);
    expect(accountingTone('POSTED')).toContain('success');
    expect(accountingTone('FAILED')).toContain('danger');
    expect(accountingTone('PENDING')).toContain('warning');
  });
});
