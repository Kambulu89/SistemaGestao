import { describe, expect, it } from 'vitest';
import {
  awardTone,
  type Comparison,
  type ComparisonOffer,
  picksPayload,
  suggestBest,
  weightSum,
} from './rfq-model';

const offer = (id: string, quantity: string, best: boolean, expired = false): ComparisonOffer => ({
  quoteLineId: id,
  quoteId: 'q',
  supplier: { id: 's', code: 'S' },
  alternativeNo: 0,
  description: null,
  quantity,
  unitPrice: '1.000000',
  taxRate: '0.000',
  currency: 'AOA',
  unitPriceBase: '1.000000',
  totalBase: '1.00',
  deliveryDays: null,
  expired,
  score: { price: 100, delivery: 0, quality: 0, payment: 0, total: 60, best },
});

const cmp = (lines: Comparison['lines']): Comparison => ({
  rfq: { id: 'r', number: 'PC-1', title: 'T', status: 'CLOSED' },
  baseCurrency: 'AOA',
  rateDate: '2026-11-18',
  rates: [],
  weights: { price: 60, delivery: 20, quality: 20, payment: 0 },
  quality: {},
  suppliers: [],
  lines,
});

describe('comparação e adjudicação (9.4)', () => {
  it('sugere a melhor de cada linha com a quantidade pedida ou a oferecida, se menor', () => {
    const c = cmp([
      {
        id: 'L1',
        lineNo: 1,
        description: 'A',
        uom: null,
        quantity: '10.000000',
        offers: [offer('a', '10.000000', false), offer('b', '12.500000', true)],
      },
      {
        id: 'L2',
        lineNo: 2,
        description: 'B',
        uom: null,
        quantity: '5.000000',
        offers: [offer('c', '2.500000', true)],
      },
      {
        id: 'L3',
        lineNo: 3,
        description: 'C',
        uom: null,
        quantity: '1.000000',
        offers: [offer('d', '1.000000', true, true)],
      },
    ]);
    expect(suggestBest(c)).toEqual({
      b: { quantity: '10', reason: '' },
      c: { quantity: '2.5', reason: '' },
    });
  });

  it('corpo das linhas: só as com quantidade, vírgula decimal e motivo opcional', () => {
    expect(
      picksPayload({
        a: { quantity: ' 2,5 ', reason: '' },
        b: { quantity: '', reason: 'x' },
        c: { quantity: '1', reason: ' Prazo ' },
      }),
    ).toEqual([
      { quoteLineId: 'a', quantity: '2.5', reason: null },
      { quoteLineId: 'c', quantity: '1', reason: 'Prazo' },
    ]);
  });

  it('soma dos pesos e cores do estado', () => {
    expect(weightSum({ price: 50, delivery: 20, quality: 20, payment: 10 })).toBe(100);
    expect(awardTone('PENDING_APPROVAL')).toContain('warning');
    expect(awardTone('APPROVED')).toContain('success');
  });
});
