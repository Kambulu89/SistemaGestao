import { describe, expect, it } from 'vitest';
import {
  documentError,
  formatDecimal,
  isPositiveQuantity,
  isRate,
  trimQuantity,
} from './orders-model';

describe('modelo de propostas e encomendas', () => {
  it('quantidade e desconto são texto com o formato do servidor', () => {
    expect(isPositiveQuantity('2.5')).toBe(true);
    expect(isPositiveQuantity('0')).toBe(false);
    expect(isPositiveQuantity('0.000000')).toBe(false);
    expect(isPositiveQuantity('1.1234567')).toBe(false);
    expect(isPositiveQuantity('-1')).toBe(false);
    expect(isRate('0.05')).toBe(true);
    expect(isRate('1')).toBe(true);
    expect(isRate('1.5')).toBe(false);
  });

  it('apresenta decimais sem perder casas', () => {
    expect(formatDecimal('1234567.8900')).toBe('1 234 567,8900');
    expect(trimQuantity('1.000000')).toBe('1');
    expect(trimQuantity('2.500000')).toBe('2,5');
  });

  it('traduz códigos conhecidos e mostra os campos que falharam', () => {
    expect(documentError({ code: 'CUSTOMER_BLOCKED', message: 'x' }, 'f')).toContain('bloqueado');
    expect(
      documentError(
        {
          code: 'VALIDATION_ERROR',
          message: 'Verifique os campos indicados.',
          fieldErrors: [{ code: 'DISCOUNT_EXCEEDS', message: 'x' }],
        },
        'f',
      ),
    ).toContain('máximo permitido');
    expect(documentError({ message: 'do servidor' }, 'f')).toBe('do servidor');
    expect(documentError(null, 'fallback')).toBe('fallback');
  });
});
