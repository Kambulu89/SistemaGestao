import { describe, expect, it } from 'vitest';
import { customerError, isMoney, localToIso } from './customers-model';

describe('modelo dos clientes', () => {
  it('o crédito é texto com até 4 casas, nunca negativo', () => {
    expect(isMoney('250000.5000')).toBe(true);
    expect(isMoney('0')).toBe(true);
    expect(isMoney('1.12345')).toBe(false);
    expect(isMoney('-1')).toBe(false);
    expect(isMoney('1,5')).toBe(false);
  });

  it('traduz os códigos conhecidos e cai na mensagem do servidor', () => {
    expect(customerError({ code: 'CUSTOMER_EXISTS', message: 'x' }, 'f')).toContain('já é cliente');
    expect(customerError({ code: 'OUTRO', message: 'do servidor' }, 'f')).toBe('do servidor');
    expect(customerError(null, 'fallback')).toBe('fallback');
    expect(
      customerError(
        {
          code: 'VALIDATION_ERROR',
          message: 'Verifique os campos indicados.',
          fieldErrors: [{ path: 'taxCountry', code: 'REQUIRED', message: 'Indique o país.' }],
        },
        'f',
      ),
    ).toBe('Indique o país.');
  });

  it('converte datas locais para ISO e recusa as inválidas', () => {
    expect(localToIso('')).toBeNull();
    expect(localToIso('nao-e-data')).toBeNull();
    expect(localToIso('2026-10-20T09:00')).toMatch(/^2026-10-20T\d{2}:\d{2}:00\.000Z$/);
  });
});
