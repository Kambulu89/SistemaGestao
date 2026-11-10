import { describe, expect, it } from 'vitest';
import {
  pickDefaults,
  receiveDefaults,
  type TransferLine,
  transferActions,
} from './transfer-model';

const can = (over = {}) => ({
  manageSource: true,
  approveSource: true,
  manageDest: true,
  approveDest: true,
  isRequester: false,
  ...over,
});

describe('transfer-model', () => {
  it('acções por estado, direitos e segregação', () => {
    expect(transferActions({ status: 'DRAFT', can: can(), intercompany: false })).toMatchObject({
      submit: true,
      approve: false,
      cancel: true,
    });
    expect(
      transferActions({
        status: 'REQUESTED',
        can: can({ isRequester: true }),
        intercompany: false,
      }),
    ).toMatchObject({ approve: false, reject: true });
    const ic = transferActions({
      status: 'REQUESTED',
      can: can(),
      intercompany: true,
      approved: { by: 'x', at: '' },
    });
    expect(ic).toMatchObject({ approve: false, accept: true });
    expect(
      transferActions({
        status: 'IN_TRANSIT',
        can: can({ approveDest: false }),
        intercompany: false,
      }),
    ).toMatchObject({ receive: true, close: false, cancel: false });
  });

  it('valores por defeito da separação e da recepção', () => {
    const lines = [
      { id: 'a', quantity: '10.000000', pickedQuantity: null, inTransitQuantity: '4.500000' },
      { id: 'b', quantity: '3.000000', pickedQuantity: '2.000000', inTransitQuantity: '0.000000' },
    ] as TransferLine[];
    expect(pickDefaults(lines)).toEqual({ a: '10', b: '2' });
    expect(receiveDefaults(lines)).toEqual({ a: '4.5' });
  });
});
