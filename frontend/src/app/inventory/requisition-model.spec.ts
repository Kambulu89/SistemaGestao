import { describe, expect, it } from 'vitest';
import {
  issueDefaults,
  pickDefaults,
  type Reservation,
  reservationLink,
  type RequisitionLine,
  requisitionActions,
} from './requisition-model';

const can = (over = {}) => ({ request: true, approve: true, fulfil: true, mine: false, ...over });
const line = (over: Partial<RequisitionLine> = {}) =>
  ({
    id: 'a',
    quantity: '30.000000',
    pickedQuantity: null,
    issuedQuantity: '0.000000',
    releasedQuantity: '0.000000',
    openQuantity: '30.000000',
    ...over,
  }) as RequisitionLine;

describe('requisition-model', () => {
  it('acções por estado, direitos e segregação', () => {
    expect(requisitionActions({ status: 'REQUESTED', can: can({ mine: true }) })).toMatchObject({
      approve: false,
      reject: true,
    });
    expect(
      requisitionActions({ status: 'APPROVED', can: can({ approve: false, request: false }) }),
    ).toMatchObject({
      issue: true,
      release: true,
      cancel: true,
    });
    expect(
      requisitionActions({
        status: 'PARTIAL',
        can: can(),
        lines: [line({ issuedQuantity: '5.000000' })],
      }),
    ).toMatchObject({ cancel: false, issue: true });
  });

  it('valores por defeito da separação e da entrega', () => {
    expect(pickDefaults([line()])).toEqual({ a: '30' });
    expect(
      issueDefaults([
        line({
          pickedQuantity: '25.000000',
          issuedQuantity: '20.000000',
          openQuantity: '10.000000',
        }),
      ]),
    ).toEqual({ a: '5' });
    expect(issueDefaults([line({ openQuantity: '0.000000' })])).toEqual({});
  });

  it('ligação para a origem da reserva', () => {
    const r = (type: string, id: string | null) =>
      ({ source: { type, id, ref: null } }) as Reservation;
    expect(reservationLink(r('INTERNAL_REQUISITION', 'x'))).toEqual([
      '/inventario/requisicoes',
      'x',
    ]);
    expect(reservationLink(r('INTERCOMPANY_TRANSFER', 'y'))).toEqual([
      '/inventario/transferencias',
      'y',
    ]);
    expect(reservationLink(r('TEST', 'z'))).toBeNull();
  });
});
