import { describe, expect, it } from 'vitest';
import {
  isoToLocal,
  localToIso,
  nextAlternative,
  plain,
  quoteForm,
  quotePayload,
  quoteTotal,
  rfqTone,
  type RfqLine,
} from './rfq-model';

const line = (id: string, quantity: string): RfqLine => ({
  id,
  version: 1,
  lineNo: 1,
  product: null,
  description: 'X',
  uom: null,
  quantity,
  specifications: null,
  neededBy: null,
  requisition: null,
});

describe('pedidos de cotação (9.3)', () => {
  it('proposta: uma oferta principal por linha com a quantidade pedida', () => {
    const f = quoteForm([line('a', '10.000000'), line('b', '1.500000')]);
    expect(f.map((r) => [r.rfqLineId, r.alternativeNo, r.quantity])).toEqual([
      ['a', 0, '10'],
      ['b', 0, '1.5'],
    ]);
  });

  it('total só das ofertas principais, com o arredondamento do servidor', () => {
    const f = quoteForm([line('a', '10'), line('b', '1')]);
    f[0].unitPrice = '1500,5';
    f[0].taxRate = '14';
    f[1].unitPrice = '25000';
    expect(quoteTotal(f)).toBe('42105.70');
    f.push({ ...f[0], alternativeNo: 1, unitPrice: '999999' });
    expect(quoteTotal(f)).toBe('42105.70');
    f[1].unitPrice = '';
    expect(quoteTotal(f)).toBeNull();
  });

  it('decimais da API sem zeros à direita', () => {
    expect(plain('10.500000')).toBe('10.5');
    expect(plain('10.000000')).toBe('10');
    expect(plain('100')).toBe('100');
  });

  it('alternativas numeradas de 1 a 9 por linha', () => {
    const f = quoteForm([line('a', '1')]);
    expect(nextAlternative(f, 'a')).toBe(1);
    for (let n = 1; n <= 9; n++) f.push({ ...f[0], alternativeNo: n });
    expect(nextAlternative(f, 'a')).toBeNull();
  });

  it('corpo da proposta e datas locais', () => {
    const [p] = quotePayload([
      {
        rfqLineId: 'a',
        alternativeNo: 1,
        description: ' Equivalente ',
        quantity: '2,5',
        unitPrice: '10,25',
        taxRate: '',
        deliveryDays: '7',
      },
    ]);
    expect(p).toEqual({
      rfqLineId: 'a',
      alternativeNo: 1,
      description: 'Equivalente',
      quantity: '2.5',
      unitPrice: '10.25',
      taxRate: '0',
      deliveryDays: 7,
    });
    expect(localToIso('')).toBeNull();
    const iso = localToIso('2026-12-01T10:30')!;
    expect(isoToLocal(iso)).toBe('2026-12-01T10:30');
    expect(rfqTone('OPEN')).toContain('warning');
  });
});
