import { describe, expect, it } from 'vitest';
import {
  buildPolicyCondition,
  describePolicyCondition,
  isValidPath,
  literalOf,
  parsePolicyCondition,
  type Clause,
} from './policy-condition';

const clause = (over: Partial<Clause>): Clause => ({
  root: 'resource',
  path: 'amount',
  operator: 'gt',
  type: 'number',
  value: '1000',
  ...over,
});

describe('condições das políticas', () => {
  it('valida os caminhos das variáveis', () => {
    expect(isValidPath('unitId')).toBe(true);
    expect(isValidPath('owner.id')).toBe(true);
    expect(isValidPath('a.b.c.d')).toBe(true);
    expect(isValidPath('a.b.c.d.e')).toBe(false);
    expect(isValidPath('1abc')).toBe(false);
    expect(isValidPath('a b')).toBe(false);
    expect(isValidPath('')).toBe(false);
  });

  it('converte o texto no tipo escolhido', () => {
    expect(literalOf('12.5', 'number')).toBe(12.5);
    expect(literalOf('abc', 'number')).toBeUndefined();
    expect(literalOf('true', 'boolean')).toBe(true);
    expect(literalOf('yes', 'boolean')).toBeUndefined();
    expect(literalOf('  x ', 'text')).toBe('x');
    expect(literalOf('', 'text')).toBeUndefined();
  });

  it('constrói uma comparação simples e liga várias por e/ou', () => {
    const one = buildPolicyCondition({ join: 'and', clauses: [clause({})] });
    expect(one).toEqual({
      ok: true,
      ast: { op: 'gt', left: { var: 'resource.amount' }, right: { value: 1000 } },
    });
    const two = buildPolicyCondition({
      join: 'or',
      clauses: [
        clause({}),
        clause({ root: 'subject', path: 'role', operator: 'eq', type: 'text', value: 'chefe' }),
      ],
    });
    expect(two.ok && two.ast).toMatchObject({ op: 'or' });
  });

  it('constrói preenchido, vazio e lista', () => {
    const filled = buildPolicyCondition({ join: 'and', clauses: [clause({ operator: 'filled' })] });
    expect(filled).toEqual({
      ok: true,
      ast: { op: 'exists', arg: { var: 'resource.amount' } },
    });
    const empty = buildPolicyCondition({ join: 'and', clauses: [clause({ operator: 'empty' })] });
    expect(empty.ok && empty.ast).toMatchObject({ op: 'not' });
    const list = buildPolicyCondition({
      join: 'and',
      clauses: [
        clause({
          root: 'resource',
          path: 'status',
          operator: 'in',
          type: 'text',
          value: 'a, b ,c',
        }),
      ],
    });
    expect(list).toEqual({
      ok: true,
      ast: { op: 'in', left: { var: 'resource.status' }, right: { value: ['a', 'b', 'c'] } },
    });
  });

  it('recusa condições vazias, caminhos e valores inválidos, com o número da condição', () => {
    expect(buildPolicyCondition({ join: 'and', clauses: [] }).ok).toBe(false);
    const path = buildPolicyCondition({ join: 'and', clauses: [clause({ path: 'a b' })] });
    expect(path.ok === false && path.message).toContain('Condição 1');
    const value = buildPolicyCondition({
      join: 'and',
      clauses: [clause({}), clause({ value: 'muito' })],
    });
    expect(value.ok === false && value.message).toContain('Condição 2');
    const badList = buildPolicyCondition({
      join: 'and',
      clauses: [clause({ operator: 'in', value: '1, x' })],
    });
    expect(badList.ok).toBe(false);
  });

  it('lê de volta o que construiu e descreve-o', () => {
    const built = buildPolicyCondition({
      join: 'and',
      clauses: [clause({}), clause({ root: 'env', path: 'hour', operator: 'gte', value: '8' })],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const draft = parsePolicyCondition(built.ast);
    expect(draft?.join).toBe('and');
    expect(draft?.clauses).toHaveLength(2);
    expect(draft?.clauses[1]).toMatchObject({
      root: 'env',
      path: 'hour',
      operator: 'gte',
      type: 'number',
      value: '8',
    });
    expect(describePolicyCondition(built.ast)).toBe(
      'resource.amount é maior que 1000 e env.hour é maior ou igual a 8',
    );
  });

  it('uma condição mais rica não se perde: não é representável e descreve-se como avançada', () => {
    const rich = {
      op: 'and',
      args: [
        { op: 'or', args: [{ op: 'true' }, { op: 'true' }] },
        { op: 'eq', left: { var: 'subject.a' }, right: { value: 1 } },
      ],
    };
    expect(parsePolicyCondition(rich)).toBeNull();
    expect(describePolicyCondition(rich)).toBe('condição avançada');
    expect(describePolicyCondition(null)).toBe('sempre');
    expect(describePolicyCondition({ op: 'true' })).toBe('condição avançada');
  });
});
