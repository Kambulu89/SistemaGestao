import { describe, expect, it } from 'vitest';
import {
  billingError,
  CONTRACT_STATUS,
  INVOICE_STATUS,
  isIsoDate,
  isMoney,
  isTaxRate,
  isZeroRate,
} from './billing-model';

describe('billing-model', () => {
  it('valida datas reais, dinheiro e taxas como texto', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('28/02/2026')).toBe(false);
    expect(isMoney('10.1234')).toBe(true);
    expect(isMoney('10.12345')).toBe(false);
    expect(isMoney('-1')).toBe(false);
    expect(isTaxRate('14')).toBe(true);
    expect(isTaxRate('14.00001')).toBe(false);
    expect(isZeroRate('0')).toBe(true);
    expect(isZeroRate('0.0000')).toBe(true);
    expect(isZeroRate('14')).toBe(false);
  });

  it('dá estados em português a facturas e contratos (expirado é um estado próprio)', () => {
    expect(INVOICE_STATUS.ISSUED.label).toBe('Emitida');
    expect(INVOICE_STATUS.CREDITED.label).toBe('Creditada');
    expect(CONTRACT_STATUS.EXPIRED.label).toBe('Expirado');
    expect(CONTRACT_STATUS.ACTIVE.label).toBe('Em vigor');
  });

  it('traduz o código do erro, depois os campos, e cai nos erros das encomendas', () => {
    expect(billingError({ code: 'INVOICE_NOT_DRAFT' }, 'x')).toContain('nota de crédito');
    expect(
      billingError(
        { code: 'VALIDATION_ERROR', fieldErrors: [{ code: 'EXCEEDS_BILLABLE', message: 'm' }] },
        'x',
      ),
    ).toContain('ultrapassa o que ainda se pode facturar');
    expect(billingError({ code: 'CUSTOMER_BLOCKED' }, 'x')).toContain('bloqueado');
    expect(billingError({}, 'Falhou.')).toBe('Falhou.');
  });
});
