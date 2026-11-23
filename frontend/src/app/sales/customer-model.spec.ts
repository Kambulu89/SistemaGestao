import { describe, expect, it } from 'vitest';
import {
  addressLine,
  customerPayload,
  customerTone,
  emptyCustomerForm,
  partnerChanges,
} from './customer-model';

describe('clientes (modelo)', () => {
  it('corpo: maiúsculas na moeda e no país; vazios a null', () => {
    const f = {
      ...emptyCustomerForm(),
      code: ' CLI-1 ',
      name: 'Cliente',
      currency: 'usd',
      countryCode: 'ao',
    };
    f.taxId = '  ';
    f.paymentTermsDays = '30';
    const b = customerPayload(f);
    expect(b).toMatchObject({
      currency: 'USD',
      paymentTermsDays: 30,
      segmentId: null,
      notes: null,
    });
    expect(b.partner).toMatchObject({ code: 'CLI-1', countryCode: 'AO', taxId: null, email: null });
  });

  it('só os campos do terceiro que mudaram', () => {
    const a = { ...emptyCustomerForm(), code: 'C', name: 'Um' };
    const b = { ...a, name: 'Dois', currency: 'USD' };
    expect(partnerChanges(a, b)).toEqual({ name: 'Dois' });
  });

  it('morada numa linha e cores do estado', () => {
    expect(
      addressLine({
        addressLine: 'Rua 1',
        city: 'Luanda',
        municipality: 'Ingombota',
        province: null,
        countryCode: 'AO',
      }),
    ).toBe('Rua 1, Ingombota, Luanda, AO');
    expect(customerTone('ACTIVE')).toContain('success');
    expect(customerTone('BLOCKED')).toContain('danger');
    expect(customerTone('INACTIVE')).toContain('muted');
  });
});
