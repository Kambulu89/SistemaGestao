import { describe, expect, it } from 'vitest';
import {
  chargeLine,
  declaredDifference,
  invoiceForm,
  invoicePayload,
  invoiceTone,
  invoiceTotal,
  type InvoiceableOrder,
} from './invoice-model';

const order: InvoiceableOrder = {
  id: 'o',
  number: 'OC-1',
  invoiceable: true,
  supplier: { id: 's', code: 'S', name: 'S' },
  currency: 'AOA',
  paymentTermsDays: 30,
  lines: [
    {
      id: 'a',
      lineNo: 1,
      description: 'Bomba',
      uom: 'UN',
      ordered: '10.000000',
      received: '6.000000',
      invoiced: '0.000000',
      toInvoice: '6.000000',
      unitPrice: '1000.000000',
      discountRate: '10.000',
      taxRate: '14.000',
    },
    {
      id: 'b',
      lineNo: 2,
      description: 'Instalação',
      uom: null,
      ordered: '1.000000',
      received: '1.000000',
      invoiced: '1.000000',
      toInvoice: '0.000000',
      unitPrice: '5000.000000',
      discountRate: '0.000',
      taxRate: '0.000',
    },
  ],
};

describe('facturas de fornecedor (9.8)', () => {
  it('formulário com o que falta facturar e os preços da ordem', () => {
    const f = invoiceForm(order);
    expect(
      f.map((l) => [l.orderLineId, l.quantity, l.unitPrice, l.discountRate, l.taxRate]),
    ).toEqual([
      ['a', '6', '1000', '10', '14'],
      ['b', '', '5000', '0', '0'],
    ]);
    expect(invoiceTotal(f)).toBe('6156.00');
  });

  it('corpo: só as linhas preenchidas; encargos com descrição', () => {
    const f = [
      ...invoiceForm(order),
      { ...chargeLine(), description: ' Transporte ', unitPrice: '2000' },
    ];
    expect(invoicePayload(f)).toEqual([
      {
        orderLineId: 'a',
        description: undefined,
        quantity: '6',
        unitPrice: '1000',
        discountRate: '10',
        taxRate: '14',
      },
      {
        orderLineId: null,
        description: 'Transporte',
        quantity: '1',
        unitPrice: '2000',
        discountRate: '0',
        taxRate: '0',
      },
    ]);
    expect(invoiceTotal(f)).toBe('8156.00');
  });

  it('diferença entre o declarado e as linhas, e cores', () => {
    expect(declaredDifference('6156,50', '6156.00')).toBe('0.50');
    expect(declaredDifference('6100', '6156.00')).toBe('-56.00');
    expect(declaredDifference('x', '1.00')).toBeNull();
    expect(invoiceTone('PENDING_EXCEPTION')).toContain('warning');
  });
});
