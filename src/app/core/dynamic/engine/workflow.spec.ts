import { defineEntity } from './define-entity';
import { VEHICLE_V2 } from '../../mock/mock-entities';
import {
  applyTransition,
  availableTransitions,
  initialStatus,
  statusOf,
  transitionsFrom,
} from './workflow';

const operator = new Set(['entities.vehicle.transition']);
const approver = new Set(['entities.vehicle.transition', 'entities.vehicle.approve']);
const access = (granted: ReadonlySet<string>) => ({ can: (p: string) => granted.has(p) });
const record = (status: string, data = {}) => ({ status, data });

describe('workflow engine: Viatura', () => {
  it('starts in the workflow initial status', () => {
    expect(initialStatus(VEHICLE_V2)).toBe('available');
    expect(statusOf(VEHICLE_V2, 'maintenance')?.name).toBe('Em manutenção');
  });

  it('offers only the transitions from the current status', () => {
    const keys = (s: string) => transitionsFrom(VEHICLE_V2, s).map((t) => t.key);
    expect(keys('available')).toEqual(['send-to-maintenance', 'deactivate']);
    expect(keys('maintenance')).toEqual(['finish-maintenance']);
    expect(keys('inactive')).toEqual(['reactivate']);
  });

  it('follows the diagram: available → maintenance → available', () => {
    const toMaintenance = applyTransition(
      VEHICLE_V2,
      record('available'),
      'send-to-maintenance',
      access(operator),
    );
    expect(toMaintenance).toMatchObject({ ok: true, status: 'maintenance' });

    const back = applyTransition(
      VEHICLE_V2,
      record('maintenance'),
      'finish-maintenance',
      access(operator),
    );
    expect(back).toMatchObject({
      ok: true,
      status: 'available',
      events: ['vehicle.maintenance.finished'],
    });
  });

  it('requires approval permission to deactivate', () => {
    const blocked = availableTransitions(VEHICLE_V2, record('available'), access(operator));
    expect(blocked.find((a) => a.transition.key === 'deactivate')?.blockedBy).toBe('approval');
    expect(
      applyTransition(VEHICLE_V2, record('available'), 'deactivate', access(operator)),
    ).toMatchObject({ ok: false, reason: 'approval' });
    expect(
      applyTransition(VEHICLE_V2, record('available'), 'deactivate', access(approver)),
    ).toMatchObject({ ok: true, status: 'inactive' });
  });

  it('blocks everything without the entity transition permission', () => {
    const result = applyTransition(
      VEHICLE_V2,
      record('available'),
      'send-to-maintenance',
      access(new Set()),
    );
    expect(result).toMatchObject({ ok: false, reason: 'permission' });
  });

  it('rejects a transition that does not exist from the current status', () => {
    expect(
      applyTransition(VEHICLE_V2, record('maintenance'), 'deactivate', access(approver)),
    ).toMatchObject({ ok: false, reason: 'unknown' });
    expect(
      applyTransition(VEHICLE_V2, record('available'), 'nope', access(approver)),
    ).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

describe('workflow engine: conditions, actions and entities without workflow', () => {
  const entity = defineEntity({
    key: 'job',
    tenantId: 't',
    names: { singular: 'Tarefa', plural: 'Tarefas' },
    icon: 'clipboard',
    fields: [
      { type: 'text', key: 'responsavel', label: 'Responsável' },
      { type: 'boolean', key: 'revisto', label: 'Revisto' },
    ],
    statuses: [
      { code: 'open', name: 'Aberta', initial: true },
      { code: 'done', name: 'Concluída', final: true },
    ],
    workflow: {
      name: 'Tarefas',
      initialStatus: 'open',
      transitions: [
        {
          key: 'close',
          name: 'Concluir',
          from: ['open'],
          to: 'done',
          condition: { op: 'eq', field: 'revisto', value: true },
          actions: [{ type: 'setField', field: 'responsavel', value: 'sistema' }],
        },
      ],
    },
  });
  const all = access(new Set(['entities.job.transition']));

  it('blocks a transition whose condition fails, and runs its actions when it holds', () => {
    expect(applyTransition(entity, record('open', { revisto: false }), 'close', all)).toMatchObject(
      { ok: false, reason: 'condition' },
    );
    const ok = applyTransition(entity, record('open', { revisto: true }), 'close', all);
    expect(ok).toMatchObject({
      ok: true,
      status: 'done',
      data: { responsavel: 'sistema', revisto: true },
    });
  });

  it('does not mutate the record it receives', () => {
    const data = Object.freeze({ revisto: true });
    expect(() => applyTransition(entity, record('open', data), 'close', all)).not.toThrow();
    expect(data).toEqual({ revisto: true });
  });

  it('allows any change between statuses when there is no workflow', () => {
    const free = defineEntity({
      key: 'ticket',
      tenantId: 't',
      names: { singular: 'Ticket', plural: 'Tickets' },
      icon: 'chat',
      fields: [{ type: 'text', key: 'x', label: 'X' }],
      statuses: [
        { code: 'a', name: 'A', initial: true },
        { code: 'b', name: 'B' },
        { code: 'c', name: 'C' },
      ],
    });
    expect(transitionsFrom(free, 'a').map((t) => t.to)).toEqual(['b', 'c']);
    expect(initialStatus(free)).toBe('a');
    expect(
      applyTransition(free, record('a'), 'to-c', access(new Set(['entities.ticket.transition']))),
    ).toMatchObject({ ok: true, status: 'c' });
  });

  it('has no status at all for entities without statuses', () => {
    expect(
      initialStatus(
        defineEntity({
          key: 'x',
          tenantId: 't',
          names: { singular: 'X', plural: 'X' },
          icon: 'cube',
          fields: [{ type: 'text', key: 'a', label: 'A' }],
        }),
      ),
    ).toBeNull();
  });
});
