import { describe, expect, it } from 'vitest';
import { type CountLine, countActions, countedChanges, linesWithDifference } from './count-model';

const line = (over: Partial<CountLine> = {}): CountLine => ({
  id: 'l1',
  lineNo: 1,
  location: null,
  product: { id: 'p', sku: 'P', name: 'P' },
  variant: null,
  uom: 'UN',
  decimals: 0,
  countedQuantity: null,
  round: 1,
  recountRequested: false,
  recountReason: null,
  addedDuringCount: false,
  entries: 0,
  snapshotQuantity: null,
  difference: null,
  movedSinceSnapshot: null,
  reasonCode: null,
  justification: null,
  ...over,
});
const can = (over = {}) => ({
  manage: false,
  approve: false,
  review: false,
  seeBook: false,
  counted: false,
  ...over,
});

describe('contagens (8.7)', () => {
  it('acções por estado e direitos', () => {
    const counter = { can: can({ manage: true }), blind: true };
    expect(countActions({ ...counter, status: 'DRAFT' })).toMatchObject({
      edit: true,
      start: true,
    });
    expect(countActions({ ...counter, status: 'COUNTING' })).toMatchObject({
      count: true,
      submit: true,
      addLine: true,
      approve: false,
    });
    // Cega: quem só gere não justifica; aberta: justifica.
    expect(countActions({ ...counter, status: 'REVIEW' }).justify).toBe(false);
    expect(countActions({ ...counter, blind: false, status: 'REVIEW' }).justify).toBe(true);
    // Quem aprova mas contou: revê e justifica, não aprova.
    const reviewer = {
      can: can({ review: true, approve: false }),
      blind: true,
      status: 'REVIEW' as const,
    };
    expect(countActions(reviewer)).toMatchObject({ justify: true, recount: true, approve: false });
    expect(countActions({ ...reviewer, can: can({ review: true, approve: true }) }).approve).toBe(
      true,
    );
    expect(countActions({ ...reviewer, status: 'APPROVED' }).cancel).toBe(false);
  });

  it('só envia quantidades que mudam o registado', () => {
    const lines = [
      line({ id: 'a', countedQuantity: '5.000000' }),
      line({ id: 'b' }),
      line({ id: 'c' }),
      line({ id: 'd', countedQuantity: '1.000000' }),
      line({ id: 'e' }),
    ];
    expect(countedChanges(lines, { a: '5', b: '2,5', c: ' ', d: '0', e: '1 000' })).toEqual([
      { lineId: 'b', quantity: '2.5' },
      { lineId: 'd', quantity: '0' },
      { lineId: 'e', quantity: '1000' },
    ]);
  });

  it('linhas com diferença', () => {
    expect(
      linesWithDifference([
        line({ id: 'a', difference: '0.000000' }),
        line({ id: 'b', difference: '-3.000000' }),
        line({ id: 'c' }),
      ]).map((l) => l.id),
    ).toEqual(['b']);
  });
});
