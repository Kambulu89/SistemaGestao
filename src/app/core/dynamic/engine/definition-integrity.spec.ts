import { DRIVER_V1, NOTE_V1, VEHICLE_V1, VEHICLE_V2 } from '../../mock/mock-entities';
import type { EntityDefinition } from '../models/entity-definition.model';
import { defineEntity, type EntityInput } from './define-entity';
import { hasErrors, validateEntityDefinition } from './definition-integrity';

const base = (over: Partial<EntityInput> = {}): EntityDefinition =>
  defineEntity({
    key: 'item',
    tenantId: 't',
    names: { singular: 'Item', plural: 'Items' },
    icon: 'cube',
    fields: [{ type: 'text', key: 'nome', label: 'Nome' }],
    ...over,
  });

const messages = (entity: EntityDefinition) =>
  validateEntityDefinition(entity)
    .filter((i) => i.severity === 'error')
    .map((i) => i.message)
    .join(' | ');

describe('validateEntityDefinition', () => {
  it.each([
    ['Viatura v1', VEHICLE_V1],
    ['Viatura v2', VEHICLE_V2],
    ['Condutor', DRIVER_V1],
    ['Nota', NOTE_V1],
  ])('the reference definition %s has no errors', (_name, entity) => {
    const issues = validateEntityDefinition(entity, {
      knownEntityKeys: new Set(['vehicle', 'driver', 'note']),
    });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('checks scope and tenant coherence', () => {
    expect(messages({ ...base(), scope: 'global' })).toContain('global não tem tenant');
    expect(messages({ ...base(), tenantId: null })).toContain('tem de indicar o tenant');
  });

  it('rejects bad, reserved and duplicated field keys', () => {
    expect(messages(base({ fields: [{ type: 'text', key: 'Nome', label: 'N' }] }))).toContain(
      'Chave de campo inválida',
    );
    expect(messages(base({ fields: [{ type: 'text', key: 'status', label: 'S' }] }))).toContain(
      'reservada',
    );
    expect(
      messages(
        base({
          fields: [
            { type: 'text', key: 'a', label: 'A' },
            { type: 'text', key: 'a', label: 'B' },
          ],
        }),
      ),
    ).toContain('duplicada');
  });

  it('checks select options and defaults', () => {
    expect(
      messages(base({ fields: [{ type: 'select', key: 's', label: 'S', options: [] }] })),
    ).toContain('pelo menos uma opção');
    expect(
      messages(
        base({
          fields: [
            {
              type: 'select',
              key: 's',
              label: 'S',
              options: [{ value: 'a', label: 'A' }],
              defaultValue: 'z',
            },
          ],
        }),
      ),
    ).toContain('valor por omissão');
  });

  it('checks reference targets only when the known keys are given', () => {
    const entity = base({
      fields: [{ type: 'reference', key: 'r', label: 'R', entityKey: 'ghost' }],
    });
    expect(validateEntityDefinition(entity)).toEqual([]);
    expect(
      validateEntityDefinition(entity, { knownEntityKeys: new Set(['item']) })[0]?.message,
    ).toContain('"ghost" não existe');
  });

  it('rejects conditions and rules that reference unknown fields', () => {
    const entity = base({
      fields: [
        { type: 'text', key: 'a', label: 'A', visibleWhen: { op: 'eq', field: 'ghost', value: 1 } },
      ],
      rules: [{ field: 'nope', type: 'required' }],
    });
    const text = messages(entity);
    expect(text).toContain('campo desconhecido "ghost"');
    expect(text).toContain('campo desconhecido "nope"');
  });

  it('rejects unsafe regular expressions and bad compare rules', () => {
    expect(
      messages(
        base({
          fields: [
            {
              type: 'text',
              key: 'a',
              label: 'A',
              validations: [{ type: 'pattern', pattern: '(a+)+$' }],
            },
          ],
        }),
      ),
    ).toContain('Padrão inválido');
    expect(
      messages(
        base({
          fields: [
            {
              type: 'number',
              key: 'a',
              label: 'A',
              validations: [{ type: 'compare', operator: 'gt', otherField: 'a' }],
            },
          ],
        }),
      ),
    ).toContain('consigo próprio');
  });

  it('keeps numeric rules on numeric fields and unique on scalar fields', () => {
    expect(
      messages(
        base({
          fields: [
            { type: 'text', key: 'a', label: 'A', validations: [{ type: 'min', value: 1 }] },
          ],
        }),
      ),
    ).toContain('só se aplica a campos numéricos');
    expect(
      messages(
        base({
          fields: [{ type: 'boolean', key: 'a', label: 'A', validations: [{ type: 'unique' }] }],
        }),
      ),
    ).toContain('unique só se aplica');
  });

  it('checks forms, list and audit references', () => {
    const entity = base({
      forms: [
        {
          key: 'f',
          name: 'F',
          modes: ['create'],
          sections: [
            { key: 's', title: 'S', columns: 1, items: [{ kind: 'field', field: 'ghost' }] },
          ],
        },
      ],
      list: {
        columns: [{ field: 'ghost' }],
        searchFields: ['ghost'],
        filters: ['nome'],
        pageSize: 500,
      },
      audit: { enabled: true, trackedFields: ['ghost'] },
    });
    const text = messages(entity);
    expect(text).toContain('refere o campo desconhecido "ghost"');
    expect(text).toContain('Coluna desconhecida');
    expect(text).toContain('Campo de pesquisa desconhecido');
    expect(text).toContain('não suporta filtro');
    expect(text).toContain('entre 1 e 100');
    expect(text).toContain('Campo auditado desconhecido');
  });

  it('checks statuses and workflow integrity', () => {
    const entity = base({
      statuses: [
        { code: 'a', name: 'A', initial: true },
        { code: 'b', name: 'B' },
        { code: 'island', name: 'Ilha' },
      ],
      workflow: {
        name: 'W',
        initialStatus: 'zzz',
        transitions: [{ key: 't', name: 'T', from: ['a'], to: 'ghost' }],
      },
    });
    const text = messages(entity);
    expect(text).toContain('Estado inicial desconhecido');
    expect(text).toContain('Estado de destino desconhecido');
  });

  it('warns (without blocking) about unreachable statuses', () => {
    const entity = base({
      statuses: [
        { code: 'a', name: 'A', initial: true },
        { code: 'b', name: 'B' },
      ],
      workflow: { name: 'W', initialStatus: 'a', transitions: [] },
    });
    const issues = validateEntityDefinition(entity);
    expect(
      issues.some((i) => i.severity === 'warning' && i.message.includes('"b" não é alcançável')),
    ).toBe(true);
    expect(hasErrors(issues)).toBe(false);
  });
});
