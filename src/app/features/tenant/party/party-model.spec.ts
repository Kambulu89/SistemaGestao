import { describe, expect, it } from 'vitest';
import { reasonsText, textOrNull, visibleSensitiveFields } from './party-model';

describe('party-model', () => {
  it('distingue campo escondido (ausente) de campo sem valor (null)', () => {
    const fields = visibleSensitiveFields({
      id: 'p',
      givenNames: 'Ana',
      familyName: 'Silva',
      birthDate: null,
      nationality: 'PT',
    });
    expect(fields.has('birthDate')).toBe(true);
    expect(fields.has('nationality')).toBe(true);
    expect(fields.has('identityNumber')).toBe(false);
    expect(fields.has('identityType')).toBe(false);
  });

  it('descreve os motivos de duplicado', () => {
    expect(reasonsText(['TAX_ID', 'CONTACT'])).toBe('mesmo NIF, mesmo contacto');
  });

  it('textOrNull apara e limpa vazios', () => {
    expect(textOrNull('  ')).toBeNull();
    expect(textOrNull(' x ')).toBe('x');
  });
});
