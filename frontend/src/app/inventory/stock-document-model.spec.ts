import { describe, expect, it } from 'vitest';
import {
  basePreview,
  checkDefaults,
  type DocLine,
  docActions,
  parseSerials,
  toMicros,
} from './stock-document-model';

describe('stock-document-model', () => {
  it('converte e pré-visualiza a quantidade base como o servidor', () => {
    expect(toMicros('1,5')).toBe(1_500_000n);
    expect(toMicros('abc')).toBeNull();
    expect(toMicros('1.0000001')).toBeNull();
    expect(basePreview('10', '24')).toBe('240');
    expect(basePreview('1', '0.333333')).toBe('0,333333');
    expect(basePreview('0,5', '3')).toBe('1,5');
    expect(basePreview('', '24')).toBeNull();
  });

  it('acções por estado e direitos', () => {
    const can = { manage: true, confirm: false };
    expect(docActions({ status: 'DRAFT', can, confirmations: [] })).toMatchObject({
      edit: true,
      check: true,
      confirm: false,
      cancel: true,
    });
    expect(docActions({ status: 'CHECKED', can: { manage: false, confirm: true } })).toMatchObject({
      confirm: true,
      reopen: false,
    });
    const partial = docActions({
      status: 'PARTIAL',
      can: { manage: true, confirm: true },
      confirmations: [{} as never],
    });
    expect(partial).toMatchObject({ edit: false, check: true, close: true, cancel: false });
  });

  it('séries e quantidades por defeito da conferência', () => {
    expect(parseSerials('A1\nA2, A3;\n')).toEqual(['A1', 'A2', 'A3']);
    expect(
      checkDefaults([
        { id: 'a', remainingQuantity: '5.000000' },
        { id: 'b', remainingQuantity: '0.250000' },
        { id: 'c', remainingQuantity: '0.000000' },
      ] as DocLine[]),
    ).toEqual({ a: '5', b: '0.25', c: '0' });
  });
});
