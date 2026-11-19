import { describe, expect, it } from 'vitest';
import {
  type CreditableInvoice,
  creditForm,
  creditNoteTone,
  creditPayload,
  creditTotal,
} from './credit-note-model';

const inv: CreditableInvoice = {
  id: 'i',
  number: 'FF-1',
  invoiceNumber: 'INV-9',
  invoiceDate: '2026-11-19',
  creditable: true,
  currency: 'AOA',
  order: { id: 'o', number: 'OC-1' },
  supplier: { id: 's', code: 'S', name: 'S' },
  totalAmount: '11156.00',
  lines: [
    {
      id: 'a',
      lineNo: 1,
      orderLineId: 'ol1',
      orderLineNo: 1,
      description: 'Bomba',
      uom: 'UN',
      quantity: '6.000000',
      netAmount: '5400.00',
      taxRate: '14.000',
      taxAmount: '756.00',
      creditedQuantity: '0.000000',
      creditedNet: '0.00',
      quantityLeft: '6.000000',
      netLeft: '5400.00',
      taxLeft: '756.00',
    },
    {
      id: 'b',
      lineNo: 2,
      orderLineId: null,
      orderLineNo: null,
      description: 'Transporte',
      uom: null,
      quantity: '1.000000',
      netAmount: '300.00',
      taxRate: '0.000',
      taxAmount: '0.00',
      creditedQuantity: '0.000000',
      creditedNet: '0.00',
      quantityLeft: '1.000000',
      netLeft: '300.00',
      taxLeft: '0.00',
    },
    {
      id: 'c',
      lineNo: 3,
      orderLineId: 'ol3',
      orderLineNo: 2,
      description: 'Já creditada',
      uom: null,
      quantity: '1.000000',
      netAmount: '100.00',
      taxRate: '0.000',
      taxAmount: '0.00',
      creditedQuantity: '1.000000',
      creditedNet: '100.00',
      quantityLeft: '0.000000',
      netLeft: '0.00',
      taxLeft: '0.00',
    },
  ],
  pendingReturns: [
    {
      returnId: 'd',
      returnNumber: 'DV-1',
      returnLineId: 'dl',
      orderLineId: 'ol1',
      pending: '2.000000',
    },
  ],
};

describe('notas de crédito (modelo)', () => {
  it('linhas com algo por creditar; com a devolução, a quantidade pendente preenchida', () => {
    expect(
      creditForm(inv, null).map((l) => [l.invoiceLineId, l.quantityAllowed, l.quantity]),
    ).toEqual([
      ['a', true, ''],
      ['b', false, ''],
    ]);
    expect(creditForm(inv, 'd')[0].quantity).toBe('2');
  });

  it('corpo: quantidade ligada à devolução escolhida e ajuste de valor', () => {
    const f = creditForm(inv, 'd');
    f[1].amount = '50';
    expect(creditPayload(f, inv, 'd')).toEqual([
      { invoiceLineId: 'a', kind: 'QUANTITY', quantity: '2', returnLineId: 'dl' },
      { invoiceLineId: 'b', kind: 'PRICE', netAmount: '50' },
    ]);
    expect(creditPayload(f, inv, null)[0].returnLineId).toBeNull();
  });

  it('total previsto como no servidor (a que fecha a linha leva o resto)', () => {
    const f = creditForm(inv, 'd');
    // 5 400 × 2 / 6 = 1 800,00 + 14% = 252,00.
    expect(creditTotal(f, inv)).toBe('2052.00');
    f[0].quantity = '6';
    f[1].amount = '300';
    expect(creditTotal(f, inv)).toBe('6456.00');
    f[0].quantity = 'x';
    expect(creditTotal(f, inv)).toBeNull();
    expect(creditNoteTone('VALIDATED')).toContain('success');
  });
});
