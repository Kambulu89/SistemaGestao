import { buildCondition, literalOf, parseCondition, type ConditionDraft } from './rule-condition';

const kinds: Record<string, 'number' | 'decimal' | 'boolean' | 'text'> = {
  desconto: 'decimal',
  quantidade: 'number',
  urgente: 'boolean',
  estado: 'text',
};
const kindOf = (field: string) => kinds[field];

describe('literalOf', () => {
  it('decimais seguem como texto; números como número; booleanos só true/false', () => {
    expect(literalOf('20', 'decimal')).toBe('20');
    expect(literalOf('20.50', 'decimal')).toBe('20.50');
    expect(literalOf('abc', 'decimal')).toBeUndefined();
    expect(literalOf('3', 'number')).toBe(3);
    expect(literalOf('', 'number')).toBeUndefined();
    expect(literalOf('true', 'boolean')).toBe(true);
    expect(literalOf('talvez', 'boolean')).toBeUndefined();
    expect(literalOf(' aberto ', 'text')).toBe('aberto');
    expect(literalOf('  ', 'text')).toBeUndefined();
  });
});

describe('buildCondition', () => {
  it('uma comparação gera o nó directamente, sem ligação', () => {
    const result = buildCondition(
      { join: 'and', clauses: [{ field: 'desconto', operator: 'gt', value: '20' }] },
      kindOf,
    );
    expect(result).toEqual({
      ok: true,
      ast: { op: 'gt', left: { var: 'resource.desconto' }, right: { value: '20' } },
    });
  });

  it('várias condições ligam-se por e/ou; preenchido e vazio não levam valor', () => {
    const draft: ConditionDraft = {
      join: 'or',
      clauses: [
        { field: 'quantidade', operator: 'lte', value: '0' },
        { field: 'estado', operator: 'filled', value: '' },
        { field: 'estado', operator: 'empty', value: '' },
      ],
    };
    expect(buildCondition(draft, kindOf)).toEqual({
      ok: true,
      ast: {
        op: 'or',
        args: [
          { op: 'lte', left: { var: 'resource.quantidade' }, right: { value: 0 } },
          { op: 'exists', arg: { var: 'resource.estado' } },
          { op: 'not', arg: { op: 'exists', arg: { var: 'resource.estado' } } },
        ],
      },
    });
  });

  it('recusa condições em falta, campo desconhecido e valores inválidos', () => {
    expect(buildCondition({ join: 'and', clauses: [] }, kindOf).ok).toBe(false);
    const unknown = buildCondition(
      { join: 'and', clauses: [{ field: 'nada', operator: 'eq', value: '1' }] },
      kindOf,
    );
    expect(unknown).toEqual({ ok: false, message: 'Condição 1: escolha um campo.' });
    const bad = buildCondition(
      { join: 'and', clauses: [{ field: 'desconto', operator: 'eq', value: 'x' }] },
      kindOf,
    );
    expect(bad).toEqual({ ok: false, message: 'Condição 1: valor inválido para o campo.' });
  });
});

describe('parseCondition', () => {
  it('é o inverso de buildCondition', () => {
    const draft: ConditionDraft = {
      join: 'and',
      clauses: [
        { field: 'desconto', operator: 'gte', value: '10.5' },
        { field: 'urgente', operator: 'eq', value: 'true' },
        { field: 'estado', operator: 'empty', value: '' },
      ],
    };
    const built = buildCondition(draft, kindOf);
    expect(built.ok && parseCondition(built.ast)).toEqual(draft);
  });

  it('o que o construtor não representa devolve null (nunca se perde em silêncio)', () => {
    expect(parseCondition(null)).toBeNull();
    expect(parseCondition({ op: 'true' })).toBeNull();
    expect(
      parseCondition({ op: 'eq', left: { var: 'subject.userId' }, right: { value: 'x' } }),
    ).toBeNull();
    expect(
      parseCondition({
        op: 'and',
        args: [
          { op: 'or', args: [{ op: 'true' }, { op: 'true' }] },
          { op: 'exists', arg: { var: 'resource.a' } },
        ],
      }),
    ).toBeNull();
    expect(
      parseCondition({ op: 'in', left: { var: 'resource.a' }, right: { value: ['x', 'y'] } }),
    ).toBeNull();
  });
});
