import { DRIVER_V1 } from '../../mock/mock-entities';
import { defineEntity } from './define-entity';
import { fieldAccessFromPermissions, resolveFieldState } from './field-state';

const cap = DRIVER_V1.fields.find((f) => f.key === 'numeroCap')!;
const nome = DRIVER_V1.fields.find((f) => f.key === 'nome')!;

describe('resolveFieldState', () => {
  it('shows and requires conditional fields only when the condition holds', () => {
    expect(resolveFieldState(cap, { values: { categoria: 'B' } }, 'create')).toEqual({
      visible: false,
      editable: false,
      required: false,
    });
    expect(resolveFieldState(cap, { values: { categoria: 'D' } }, 'create')).toEqual({
      visible: true,
      editable: true,
      required: true,
    });
  });

  it('makes everything read-only in read mode', () => {
    expect(resolveFieldState(nome, { values: {} }, 'read')).toEqual({
      visible: true,
      editable: false,
      required: true,
    });
  });

  it('honours field permissions for reading and writing', () => {
    const entity = defineEntity({
      key: 'salary',
      tenantId: 't',
      names: { singular: 'S', plural: 'S' },
      icon: 'card',
      fields: [
        {
          type: 'currency',
          key: 'valor',
          label: 'Valor',
          currency: 'EUR',
          permissions: { read: 'hr.read', write: 'hr.write' },
        },
      ],
    });
    const field = entity.fields[0]!;
    const state = (granted: string[]) =>
      resolveFieldState(
        field,
        { values: {} },
        'edit',
        fieldAccessFromPermissions((p) => granted.includes(p)),
      );

    expect(state([])).toMatchObject({ visible: false, editable: false });
    expect(state(['hr.read'])).toMatchObject({ visible: true, editable: false });
    expect(state(['hr.read', 'hr.write'])).toMatchObject({ visible: true, editable: true });
  });

  it('never shows archived fields', () => {
    expect(resolveFieldState({ ...nome, archived: true }, { values: {} }, 'read').visible).toBe(
      false,
    );
  });

  it('supports conditional editability', () => {
    const locked = {
      ...nome,
      editableWhen: { op: 'eq', field: 'status', value: 'draft' },
    } as const;
    expect(resolveFieldState(locked, { values: {}, status: 'draft' }, 'edit').editable).toBe(true);
    expect(resolveFieldState(locked, { values: {}, status: 'closed' }, 'edit').editable).toBe(
      false,
    );
  });
});
