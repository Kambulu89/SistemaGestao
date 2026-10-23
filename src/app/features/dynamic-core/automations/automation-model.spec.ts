import { describe, expect, it } from 'vitest';
import {
  canRetry,
  describeTrigger,
  emptyAction,
  toActionDraft,
  toActionDto,
} from './automation-model';
import type { ActionDescriptorDto } from './automations.api';

const descriptor: ActionDescriptorDto = {
  type: 'dynamic.record.transition',
  label: 'Transição',
  description: '',
  params: [
    { name: 'entityCode', kind: 'text', required: true, description: '' },
    { name: 'recordId', kind: 'text', required: true, description: '' },
    { name: 'reason', kind: 'text', required: false, description: '' },
  ],
};

describe('automation-model', () => {
  it('builds the API action from the draft: fixed values and event references, no empty params', () => {
    const draft = {
      type: 'dynamic.record.transition',
      params: {
        entityCode: { mode: 'fixed', value: ' pedido ' },
        recordId: { mode: 'event', value: 'recordId' },
        reason: { mode: 'fixed', value: '' },
      },
    } as const;
    expect(toActionDto(draft)).toEqual({
      type: 'dynamic.record.transition',
      params: { entityCode: 'pedido', recordId: { from: 'payload.recordId' } },
    });
  });

  it('reads an action back into a draft, keeping every declared parameter', () => {
    const draft = toActionDraft(
      {
        type: 'dynamic.record.transition',
        params: { entityCode: 'pedido', recordId: { from: 'payload.recordId' } },
      },
      descriptor,
    );
    expect(draft.params['recordId']).toEqual({ mode: 'event', value: 'recordId' });
    expect(draft.params['entityCode']).toEqual({ mode: 'fixed', value: 'pedido' });
    expect(draft.params['reason']).toEqual({ mode: 'fixed', value: '' });
    expect(emptyAction(descriptor).params['recordId']).toEqual({ mode: 'fixed', value: '' });
  });

  it('only offers a retry for failed runs that the engine rules did not close', () => {
    expect(canRetry({ status: 'DEAD', errorCode: 'ACTION_FAILED' })).toBe(true);
    expect(canRetry({ status: 'FAILED', errorCode: null })).toBe(true);
    expect(canRetry({ status: 'DEAD', errorCode: 'CAUSALITY_DEPTH' })).toBe(false);
    expect(canRetry({ status: 'DEAD', errorCode: 'PERIOD_LIMIT' })).toBe(false);
    expect(canRetry({ status: 'SUCCEEDED', errorCode: null })).toBe(false);
    expect(canRetry({ status: 'PENDING', errorCode: 'ACTION_FAILED' })).toBe(false);
  });

  it('describes the trigger with the catalog label or the schedule and its timezone', () => {
    const events = [{ type: 'a.b', label: 'Algo aconteceu', fields: [] }];
    expect(describeTrigger({ eventType: 'a.b', schedule: null, timezone: 'UTC' }, events)).toBe(
      'Algo aconteceu',
    );
    expect(describeTrigger({ eventType: 'x.y', schedule: null, timezone: 'UTC' }, events)).toBe(
      'x.y',
    );
    expect(
      describeTrigger(
        { eventType: null, schedule: '0 9 * * *', timezone: 'Africa/Luanda' },
        events,
      ),
    ).toBe('Calendário «0 9 * * *» (Africa/Luanda)');
  });
});
