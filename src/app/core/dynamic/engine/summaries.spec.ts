import { DRIVER_V1, VEHICLE_V2 } from '../../mock/mock-entities';
import { describeCondition, describeRule, FIELD_TYPE_LABELS } from './summaries';

describe('describeCondition', () => {
  it('uses field labels and option labels', () => {
    expect(describeCondition(DRIVER_V1, { op: 'in', field: 'categoria', values: ['C', 'D'] })).toBe(
      'Categoria em (C (pesados de mercadorias), D (pesados de passageiros))',
    );
    expect(describeCondition(DRIVER_V1, { op: 'empty', field: 'telefone' })).toBe('Telefone vazio');
  });

  it('uses status names for the status key (the ABAC delete policy of Viatura)', () => {
    const policy = VEHICLE_V2.permissions.policies[0]!;
    expect(describeCondition(VEHICLE_V2, policy.when)).toBe('Estado ≠ Inactiva');
  });

  it('composes and/or/not, parenthesising nested groups', () => {
    expect(
      describeCondition(VEHICLE_V2, {
        op: 'and',
        conditions: [
          { op: 'gte', field: 'quilometragem', value: 1000 },
          {
            op: 'or',
            conditions: [
              { op: 'eq', field: 'status', value: 'available' },
              { op: 'not', condition: { op: 'empty', field: 'marca' } },
            ],
          },
        ],
      }),
    ).toBe('Quilometragem ≥ 1000 e (Estado = Disponível ou não (Marca vazio))');
  });
});

describe('describeRule', () => {
  it('describes every rule type in plain Portuguese', () => {
    const d = (rule: Parameters<typeof describeRule>[1]) => describeRule(VEHICLE_V2, rule);
    expect(d({ type: 'required' })).toBe('Obrigatório');
    expect(d({ type: 'min', value: 0 })).toBe('Valor mínimo 0');
    expect(d({ type: 'maxLength', value: 17 })).toBe('Máximo de 17 caracteres');
    expect(d({ type: 'unique' })).toBe('Único por tenant (verificado no servidor)');
    expect(d({ type: 'email' })).toBe('Email válido');
    expect(d({ type: 'pattern', pattern: '^A' })).toBe('Segue o padrão /^A/');
    expect(d({ type: 'compare', operator: 'gte', otherField: 'marca' })).toBe(
      'igual ou superior a "Marca"',
    );
  });

  it('appends the condition under which the rule applies', () => {
    expect(
      describeRule(DRIVER_V1, {
        type: 'required',
        when: { op: 'eq', field: 'categoria', value: 'C' },
      }),
    ).toBe('Obrigatório, quando Categoria = C (pesados de mercadorias)');
  });

  it('labels every field type', () => {
    expect(Object.keys(FIELD_TYPE_LABELS)).toHaveLength(14);
  });
});
