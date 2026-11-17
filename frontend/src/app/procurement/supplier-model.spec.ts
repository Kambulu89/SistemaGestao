import { describe, expect, it } from 'vitest';
import {
  emptySupplierForm,
  partnerChanges,
  qualificationText,
  supplierPayload,
  supplierTone,
} from './supplier-model';

describe('fornecedores (9.1)', () => {
  it('texto da homologação', () => {
    const base = { warningDays: 30, missing: [], expired: [], expiring: [] };
    expect(
      qualificationText({
        ...base,
        valid: false,
        missing: ['AGT'],
        expired: ['SS'],
        expiresOn: null,
      }),
    ).toBe('Documentos obrigatórios em falta: AGT; fora de validade: SS.');
    expect(
      qualificationText({ ...base, valid: true, expiresOn: '2026-12-01', expiring: ['AGT'] }),
    ).toBe('Documentos obrigatórios em dia até 01/12/2026 (a caducar: AGT).');
    expect(qualificationText({ ...base, valid: true, expiresOn: null })).toContain('sem data');
    expect(supplierTone('APPROVED')).toContain('success');
    expect(supplierTone('SUSPENDED')).toContain('danger');
  });

  it('corpo do pedido e alterações da ficha', () => {
    const f = {
      ...emptySupplierForm(),
      code: ' F-1 ',
      name: 'Kwanza',
      minOrderAmount: '1500,50',
      leadTimeDays: '',
    };
    const p = supplierPayload(f);
    expect(p.partner).toMatchObject({
      code: 'F-1',
      name: 'Kwanza',
      taxId: null,
      countryCode: 'AO',
    });
    expect(p).toMatchObject({
      minOrderAmount: '1500.50',
      leadTimeDays: null,
      paymentTermsDays: 30,
      currency: 'AOA',
    });
    expect(partnerChanges(f, { ...f, phone: '+244 900' })).toEqual({ phone: '+244 900' });
    expect(partnerChanges(f, f)).toEqual({});
  });
});
