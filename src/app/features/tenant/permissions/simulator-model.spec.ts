import { describe, expect, it } from 'vitest';
import { parseResource, REASON_TEXT } from './simulator-model';

describe('simulador de autorização', () => {
  it('o recurso é opcional e tem de ser um objecto JSON', () => {
    expect(parseResource('  ')).toEqual({ ok: true, value: null });
    expect(parseResource('{"amount": 1500}')).toEqual({ ok: true, value: { amount: 1500 } });
    expect(parseResource('[1]').ok).toBe(false);
    expect(parseResource('"texto"').ok).toBe(false);
    expect(parseResource('null').ok).toBe(false);
    expect(parseResource('{amount:').ok).toBe(false);
  });

  it('explica todas as razões que o servidor devolve', () => {
    for (const reason of [
      'GRANTED',
      'NO_PERMISSION',
      'UNIT_MISMATCH',
      'UNIT_OUT_OF_SCOPE',
      'POLICY_DENY',
      'POLICY_ERROR',
      'NO_ALLOW_POLICY_MATCHED',
    ]) {
      expect(REASON_TEXT[reason]).toBeTruthy();
    }
  });
});
