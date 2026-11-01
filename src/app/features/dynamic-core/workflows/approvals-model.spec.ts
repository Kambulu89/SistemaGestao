import { describe, expect, it } from 'vitest';
import {
  amountLabel,
  memberName,
  parseWorkflowCodes,
  recordPath,
  taskActions,
} from './approvals-model';
import type { TaskViewDto } from './workflows.api';

const item = (can: { claim: boolean; decide: boolean }): TaskViewDto =>
  ({ can, amount: '1500.00', currency: 'EUR' }) as unknown as TaskViewDto;

describe('approvals-model', () => {
  it('lists the actions the server allows, in presentation order', () => {
    expect(taskActions(item({ claim: true, decide: false }))).toEqual(['claim']);
    expect(taskActions(item({ claim: false, decide: true }))).toEqual([
      'approve',
      'reject',
      'return',
    ]);
    expect(taskActions(item({ claim: false, decide: false }))).toEqual([]);
  });

  it('shows amounts as the server sent them (decimal strings)', () => {
    expect(amountLabel({ amount: '1500.00', currency: 'EUR' })).toBe('1500.00 EUR');
    expect(amountLabel({ amount: '10.5000', currency: null })).toBe('10.5000');
    expect(amountLabel({ amount: null, currency: 'EUR' })).toBe('—');
  });

  it('names members, falling back to a short id when the list is not readable', () => {
    const members = [
      { id: 'a', displayName: 'Ana', email: 'ana@x.pt' },
      { id: 'b', displayName: null, email: 'bruno@x.pt' },
    ];
    expect(memberName(members, 'a')).toBe('Ana');
    expect(memberName(members, 'b')).toBe('bruno@x.pt');
    expect(memberName([], '12345678-aaaa')).toBe('Membro 12345678');
    expect(memberName(members, null)).toBe('—');
  });

  it('parses workflow codes and builds the record path', () => {
    expect(parseWorkflowCodes(' despesas, ferias;compras ')).toEqual([
      'despesas',
      'ferias',
      'compras',
    ]);
    expect(parseWorkflowCodes('  ')).toEqual([]);
    expect(recordPath('acme', 'despesa', 'r1')).toEqual(['/t', 'acme', 'data', 'despesa', 'r1']);
  });
});
