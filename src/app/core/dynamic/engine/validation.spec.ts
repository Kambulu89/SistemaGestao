import { DRIVER_V1, NOTE_V1, VEHICLE_V2 } from '../../mock/mock-entities';
import { defineEntity } from './define-entity';
import { fieldAccessFromPermissions } from './field-state';
import {
  rulesForField,
  ruleRuntime,
  safeRegExp,
  validateField,
  validateRecordData,
} from './validation';

const field = (entity: typeof VEHICLE_V2, key: string) => entity.fields.find((f) => f.key === key)!;

describe('validation engine: Viatura', () => {
  const valid = { matricula: 'AA-11-BB', marca: 'Volvo', quilometragem: 1000 };

  it('accepts a valid vehicle', () => {
    expect(validateRecordData(VEHICLE_V2, valid, { mode: 'create' })).toEqual([]);
  });

  it('requires matricula and marca', () => {
    const issues = validateRecordData(VEHICLE_V2, { quilometragem: 0 }, { mode: 'create' });
    expect(issues.map((i) => [i.fieldKey, i.rule])).toEqual([
      ['matricula', 'required'],
      ['marca', 'required'],
    ]);
  });

  it('rejects negative mileage but accepts zero', () => {
    expect(
      validateRecordData(VEHICLE_V2, { ...valid, quilometragem: -1 }, { mode: 'create' }),
    ).toEqual([
      { fieldKey: 'quilometragem', rule: 'min', message: 'A quilometragem não pode ser negativa.' },
    ]);
    expect(
      validateRecordData(VEHICLE_V2, { ...valid, quilometragem: 0 }, { mode: 'create' }),
    ).toEqual([]);
  });

  it('applies max length to the chassis number', () => {
    const issues = validateRecordData(
      VEHICLE_V2,
      { ...valid, numeroChassis: 'X'.repeat(18) },
      { mode: 'create' },
    );
    expect(issues).toEqual([
      { fieldKey: 'numeroChassis', rule: 'maxLength', message: 'Máximo de 17 caracteres.' },
    ]);
  });

  it('leaves "unique" to the backend: no client issue, but the rule is declared', () => {
    const rule = rulesForField(VEHICLE_V2, field(VEHICLE_V2, 'matricula')).find(
      (r) => r.type === 'unique',
    );
    expect(rule).toBeDefined();
    expect(ruleRuntime(rule!)).toBe('server');
    expect(validateRecordData(VEHICLE_V2, valid, { mode: 'create' })).toEqual([]);
  });
});

describe('validation engine: conditional and cross-field rules', () => {
  const driver = { nome: 'Rui', numeroCarta: '123', validadeCarta: '2030-01-01' };

  it('requires the CAP number only for heavy categories', () => {
    expect(
      validateRecordData(DRIVER_V1, { ...driver, categoria: 'B' }, { mode: 'create' }),
    ).toEqual([]);
    const issues = validateRecordData(DRIVER_V1, { ...driver, categoria: 'C' }, { mode: 'create' });
    expect(issues.map((i) => [i.fieldKey, i.rule])).toEqual([['numeroCap', 'required']]);
    expect(
      validateRecordData(
        DRIVER_V1,
        { ...driver, categoria: 'C', numeroCap: 'CAP-1' },
        { mode: 'create' },
      ),
    ).toEqual([]);
  });

  it('does not validate hidden fields', () => {
    const issues = validateRecordData(
      DRIVER_V1,
      { ...driver, categoria: 'B', numeroCap: '' },
      { mode: 'create' },
    );
    expect(issues).toEqual([]);
  });

  it('validates the implicit email and phone formats of the field type', () => {
    const issues = validateRecordData(
      DRIVER_V1,
      { ...driver, categoria: 'B', email: 'not-an-email', telefone: 'abc' },
      { mode: 'create' },
    );
    expect(issues.map((i) => i.fieldKey).sort()).toEqual(['email', 'telefone']);
  });

  const compare = defineEntity({
    key: 'booking',
    tenantId: 't',
    names: { singular: 'Reserva', plural: 'Reservas' },
    icon: 'calendar',
    fields: [
      { type: 'date', key: 'inicio', label: 'Início' },
      { type: 'date', key: 'fim', label: 'Fim' },
      { type: 'number', key: 'desconto', label: 'Desconto' },
      { type: 'text', key: 'motivo', label: 'Motivo' },
    ],
    rules: [
      { field: 'fim', type: 'compare', operator: 'gte', otherField: 'inicio' },
      // Condicional: só se aplica quando há desconto.
      {
        field: 'motivo',
        type: 'minLength',
        value: 10,
        when: { op: 'gt', field: 'desconto', value: 0 },
      },
    ],
  });

  it('compares two fields', () => {
    const issues = validateRecordData(
      compare,
      { inicio: '2026-05-10', fim: '2026-05-01' },
      { mode: 'create' },
    );
    expect(issues).toEqual([
      { fieldKey: 'fim', rule: 'compare', message: 'Tem de ser igual ou superior a "Início".' },
    ]);
    expect(
      validateRecordData(compare, { inicio: '2026-05-01', fim: '2026-05-01' }, { mode: 'create' }),
    ).toEqual([]);
  });

  it('skips the comparison when the other field is empty', () => {
    expect(validateRecordData(compare, { fim: '2026-05-01' }, { mode: 'create' })).toEqual([]);
  });

  it('applies a rule only when its "when" condition holds', () => {
    expect(validateRecordData(compare, { motivo: 'curto' }, { mode: 'create' })).toEqual([]);
    const issues = validateRecordData(
      compare,
      { motivo: 'curto', desconto: 5 },
      { mode: 'create' },
    );
    expect(issues.map((i) => i.rule)).toEqual(['minLength']);
  });
});

describe('validation engine: modes and permissions', () => {
  it('does not validate read-only fields (the user cannot fix them)', () => {
    expect(validateRecordData(VEHICLE_V2, {}, { mode: 'read' })).toEqual([]);
  });

  it('does not require fields the user may not write', () => {
    const access = fieldAccessFromPermissions(() => false);
    const restricted = defineEntity({
      key: 'secret',
      tenantId: 't',
      names: { singular: 'S', plural: 'S' },
      icon: 'lock',
      fields: [
        {
          type: 'text',
          key: 'x',
          label: 'X',
          required: true,
          permissions: { write: 'secret.write' },
        },
      ],
    });
    expect(validateRecordData(restricted, {}, { mode: 'create', access })).toEqual([]);
  });

  it('skips non-required empty fields and honours custom messages', () => {
    const f = field(VEHICLE_V2, 'modelo');
    expect(validateField(VEHICLE_V2, f, '', { values: {} }, { required: false })).toEqual([]);
    const m = field(VEHICLE_V2, 'matricula');
    expect(validateField(VEHICLE_V2, m, '', { values: {} }, { required: true })[0]?.message).toBe(
      'Campo obrigatório.',
    );
  });

  it('validates plain text notes', () => {
    expect(validateRecordData(NOTE_V1, { titulo: 'Reunião' }, { mode: 'create' })).toEqual([]);
  });
});

describe('safeRegExp', () => {
  it('compiles reasonable patterns', () => {
    expect(safeRegExp('^[A-Z]{2}-\\d{2}$')?.test('AB-12')).toBe(true);
    expect(safeRegExp('abc', true)?.test('ABC')).toBe(true);
  });

  it.each(['(a+)+$', '([a-z]*)*', '(', ''])('refuses %j', (pattern) => {
    expect(safeRegExp(pattern)).toBeNull();
  });

  it('refuses patterns that are too long', () => {
    expect(safeRegExp('a'.repeat(300))).toBeNull();
  });
});
