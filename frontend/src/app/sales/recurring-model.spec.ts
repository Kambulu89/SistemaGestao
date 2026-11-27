import { FREQUENCY, RECURRING_STATUS, recurringTone } from './recurring-model';

describe('recurring-model', () => {
  it('rótulos e tons semânticos', () => {
    expect(FREQUENCY['QUARTERLY']).toBe('Trimestral');
    expect(RECURRING_STATUS['ENDED']).toBe('Terminado');
    expect(recurringTone('FAILED')).toContain('danger');
    expect(recurringTone('ACTIVE')).toContain('success');
  });
});
