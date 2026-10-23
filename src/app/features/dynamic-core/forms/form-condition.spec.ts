import {
  buildFormCondition,
  conditionLiteral,
  describeFormCondition,
  parseFormCondition,
  type FormConditionDraft,
} from './form-condition';

const kinds = { prioridade: 'text', quantidade: 'number', urgente: 'boolean' } as const;
const kindOf = (field: string) => (kinds as Record<string, 'text' | 'number' | 'boolean'>)[field];

describe('conditionLiteral', () => {
  it('números como número, booleanos só true/false, texto aparado', () => {
    expect(conditionLiteral('3.5', 'number')).toBe(3.5);
    expect(conditionLiteral('', 'number')).toBeUndefined();
    expect(conditionLiteral('x', 'number')).toBeUndefined();
    expect(conditionLiteral('true', 'boolean')).toBe(true);
    expect(conditionLiteral('talvez', 'boolean')).toBeUndefined();
    expect(conditionLiteral(' alta ', 'text')).toBe('alta');
    expect(conditionLiteral('  ', 'text')).toBeUndefined();
  });
});

describe('buildFormCondition', () => {
  it('uma comparação gera o nó directamente; várias ligam-se; preenchido/vazio não levam valor', () => {
    expect(
      buildFormCondition(
        { join: 'and', clauses: [{ field: 'prioridade', operator: 'eq', value: 'alta' }] },
        kindOf,
      ),
    ).toEqual({ ok: true, condition: { op: 'eq', field: 'prioridade', value: 'alta' } });

    expect(
      buildFormCondition(
        {
          join: 'or',
          clauses: [
            { field: 'quantidade', operator: 'gt', value: '10' },
            { field: 'prioridade', operator: 'notEmpty', value: '' },
          ],
        },
        kindOf,
      ),
    ).toEqual({
      ok: true,
      condition: {
        op: 'or',
        conditions: [
          { op: 'gt', field: 'quantidade', value: 10 },
          { op: 'notEmpty', field: 'prioridade' },
        ],
      },
    });
  });

  it('recusa condições em falta, campo desconhecido e valor inválido', () => {
    expect(buildFormCondition({ join: 'and', clauses: [] }, kindOf).ok).toBe(false);
    expect(
      buildFormCondition(
        { join: 'and', clauses: [{ field: 'nada', operator: 'eq', value: '1' }] },
        kindOf,
      ),
    ).toEqual({ ok: false, message: 'Condição 1: escolha um campo.' });
    expect(
      buildFormCondition(
        { join: 'and', clauses: [{ field: 'quantidade', operator: 'eq', value: 'x' }] },
        kindOf,
      ),
    ).toEqual({ ok: false, message: 'Condição 1: valor inválido para o campo.' });
  });
});

describe('parseFormCondition', () => {
  it('é o inverso de buildFormCondition', () => {
    const draft: FormConditionDraft = {
      join: 'and',
      clauses: [
        { field: 'prioridade', operator: 'neq', value: 'baixa' },
        { field: 'quantidade', operator: 'lte', value: '4' },
        { field: 'urgente', operator: 'empty', value: '' },
      ],
    };
    const built = buildFormCondition(draft, kindOf);
    expect(built.ok && parseFormCondition(built.condition)).toEqual(draft);
  });

  it('o que o construtor não representa devolve null (nunca se perde)', () => {
    expect(parseFormCondition(undefined)).toBeNull();
    expect(parseFormCondition({ op: 'in', field: 'a', values: ['x'] })).toBeNull();
    expect(parseFormCondition({ op: 'not', condition: { op: 'empty', field: 'a' } })).toBeNull();
    expect(
      parseFormCondition({
        op: 'and',
        conditions: [
          {
            op: 'or',
            conditions: [
              { op: 'empty', field: 'a' },
              { op: 'empty', field: 'b' },
            ],
          },
          { op: 'empty', field: 'c' },
        ],
      }),
    ).toBeNull();
  });
});

describe('describeFormCondition', () => {
  it('escreve a condição com os rótulos dos campos', () => {
    const label = (f: string) => ({ prioridade: 'Prioridade', quantidade: 'Quantidade' })[f] ?? f;
    expect(
      describeFormCondition(
        {
          op: 'and',
          conditions: [
            { op: 'eq', field: 'prioridade', value: 'alta' },
            { op: 'notEmpty', field: 'quantidade' },
          ],
        },
        label,
      ),
    ).toBe('Prioridade é igual a alta e Quantidade está preenchido');
    expect(
      describeFormCondition({ op: 'in', field: 'prioridade', values: ['a', 'b'] }, label),
    ).toBe('Prioridade está em a, b');
  });
});
