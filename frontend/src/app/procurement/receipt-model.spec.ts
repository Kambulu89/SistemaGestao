import { describe, expect, it } from 'vitest';
import {
  deliveryTone,
  receiptForm,
  receiptPayload,
  receiptTone,
  type ReceivableOrder,
} from './receipt-model';

const order: ReceivableOrder = {
  id: 'o',
  number: 'OC-1',
  receivable: true,
  supplier: { id: 's', code: 'S', name: 'S' },
  warehouseId: 'w',
  expectedDate: null,
  locations: [],
  lines: [
    {
      id: 'a',
      lineNo: 1,
      product: { id: 'p', sku: 'BOMBA' },
      description: 'Bomba',
      uom: 'UN',
      stocked: true,
      ordered: '10.000000',
      received: '6.000000',
      open: '4.000000',
      expectedDate: null,
      tracking: { lots: true, expiry: true, serials: false },
    },
    {
      id: 'b',
      lineNo: 2,
      product: null,
      description: 'Instalação',
      uom: null,
      stocked: false,
      ordered: '1.000000',
      received: '1.000000',
      open: '0.000000',
      expectedDate: null,
      tracking: { lots: false, expiry: false, serials: false },
    },
  ],
};

describe('recepções (9.7)', () => {
  it('formulário só com o que falta, com a quantidade em falta', () => {
    const f = receiptForm(order);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      orderLineId: 'a',
      description: 'BOMBA — Bomba',
      quantity: '4',
      stocked: true,
    });
  });

  it('corpo: ignora linhas a zero, vírgula decimal, séries por linha ou vírgula', () => {
    const f = receiptForm(order);
    f[0].quantity = '3,5';
    f[0].rejectedQuantity = '0,5';
    f[0].rejectReason = ' Danificada ';
    f[0].lotCode = 'L1';
    f[0].serials = 'S1, S2\nS3;';
    expect(receiptPayload(f)).toEqual([
      {
        orderLineId: 'a',
        quantity: '3.5',
        rejectedQuantity: '0.5',
        rejectReason: 'Danificada',
        locationId: null,
        lotCode: 'L1',
        expiryDate: null,
        serials: ['S1', 'S2', 'S3'],
      },
    ]);
    f[0].quantity = '0';
    f[0].rejectedQuantity = '';
    expect(receiptPayload(f)).toEqual([]);
  });

  it('cores', () => {
    expect(receiptTone('CONFIRMED')).toContain('success');
    expect(deliveryTone('OVERDUE')).toContain('danger');
  });
});
