import { describe, expect, it } from 'vitest';
import {
  creditTone,
  overLeft,
  returnForm,
  returnPayload,
  type ReturnableReceipt,
  returnTone,
  withReturn,
} from './return-model';

const receipt: ReturnableReceipt = {
  id: 'r',
  number: 'RE-1',
  returnable: true,
  order: { id: 'o', number: 'OC-1', closed: false },
  supplier: { id: 's', code: 'S', name: 'S' },
  warehouseId: 'w',
  receiptDate: '2026-11-19',
  locations: [],
  lines: [
    {
      id: 'a',
      lineNo: 1,
      orderLineNo: 1,
      product: { id: 'p', sku: 'BOMBA' },
      description: 'Bomba',
      uom: 'UN',
      baseUom: 'UN',
      stocked: true,
      accepted: '6.000000',
      refused: '2.000000',
      rejectReason: 'Rachada',
      acceptedLeft: '4.000000',
      refusedLeft: '2.000000',
      location: { id: 'loc', path: 'A-1' },
      lotCode: 'L1',
      serials: [],
      tracking: { lots: true, serials: false },
    },
    {
      id: 'b',
      lineNo: 2,
      orderLineNo: 2,
      product: null,
      description: 'Instalação',
      uom: null,
      baseUom: null,
      stocked: false,
      accepted: '1.000000',
      refused: '0.000000',
      rejectReason: null,
      acceptedLeft: '0.000000',
      refusedLeft: '0.000000',
      location: null,
      lotCode: null,
      serials: [],
      tracking: { lots: false, serials: false },
    },
  ],
};

describe('devoluções (modelo)', () => {
  it('uma linha por origem com algo por devolver; o aceite traz a localização da recepção', () => {
    const f = returnForm(receipt);
    expect(f.map((l) => [l.receiptLineId, l.source, l.left, l.stocked])).toEqual([
      ['a', 'ACCEPTED', '4.000000', true],
      ['a', 'REFUSED', '2.000000', false],
    ]);
    expect(f[0].locationId).toBe('loc');
    expect(f[0].label).toBe('1 · BOMBA — Bomba');
  });

  it('corpo: só linhas com quantidade; estado e séries só no que sai do stock', () => {
    const f = returnForm(receipt);
    f[0].quantity = '2,5';
    f[0].bucket = 'BLOCKED';
    f[0].serials = 'S1, S2\nS3';
    f[1].quantity = '1';
    f[1].notes = ' rachada ';
    expect(returnPayload(f)).toEqual([
      {
        receiptLineId: 'a',
        source: 'ACCEPTED',
        quantity: '2.5',
        bucket: 'BLOCKED',
        locationId: 'loc',
        serials: ['S1', 'S2', 'S3'],
        notes: null,
      },
      { receiptLineId: 'a', source: 'REFUSED', quantity: '1', notes: 'rachada' },
    ]);
    f[0].quantity = '0';
    f[1].quantity = '';
    expect(returnPayload(f)).toEqual([]);
  });

  it('edição: junta as quantidades do rascunho; aviso acima do disponível; cores', () => {
    const f = withReturn(returnForm(receipt), [
      {
        receiptLineId: 'a',
        source: 'REFUSED',
        quantity: '2.000000',
        bucket: null,
        location: null,
        serials: [],
        notes: 'x',
      },
    ]);
    expect(f[1].quantity).toBe('2');
    expect(f[1].notes).toBe('x');
    expect(f[0].quantity).toBe('');
    f[0].quantity = '4.5';
    expect(overLeft(f[0])).toBe(true);
    f[0].quantity = '4';
    expect(overLeft(f[0])).toBe(false);
    expect(returnTone('CONFIRMED')).toContain('success');
    expect(creditTone('PENDING')).toContain('warning');
    expect(creditTone('NOT_REQUIRED')).toContain('muted');
  });
});
