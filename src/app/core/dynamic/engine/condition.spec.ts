import type { Condition } from '../models/condition.model';
import {
  conditionDepth,
  conditionFields,
  evaluateCondition,
  isEmptyValue,
  MAX_CONDITION_DEPTH,
} from './condition';

const ctx = (
  values: Record<string, never | string | number | boolean | string[] | null>,
  status: string | null = null,
) => ({
  values: values as never,
  status,
});

describe('evaluateCondition', () => {
  it.each<[string, Condition, boolean]>([
    ['eq', { op: 'eq', field: 'a', value: 'x' }, true],
    ['neq', { op: 'neq', field: 'a', value: 'x' }, false],
    ['gt', { op: 'gt', field: 'n', value: 5 }, true],
    ['gte', { op: 'gte', field: 'n', value: 10 }, true],
    ['lt', { op: 'lt', field: 'n', value: 10 }, false],
    ['lte', { op: 'lte', field: 'n', value: 10 }, true],
    ['in', { op: 'in', field: 'a', values: ['x', 'y'] }, true],
    ['nin', { op: 'nin', field: 'a', values: ['x', 'y'] }, false],
    ['empty', { op: 'empty', field: 'missing' }, true],
    ['notEmpty', { op: 'notEmpty', field: 'a' }, true],
    [
      'and',
      {
        op: 'and',
        conditions: [
          { op: 'eq', field: 'a', value: 'x' },
          { op: 'gt', field: 'n', value: 1 },
        ],
      },
      true,
    ],
    [
      'or',
      {
        op: 'or',
        conditions: [
          { op: 'eq', field: 'a', value: 'z' },
          { op: 'eq', field: 'n', value: 10 },
        ],
      },
      true,
    ],
    ['not', { op: 'not', condition: { op: 'eq', field: 'a', value: 'x' } }, false],
  ])('%s', (_name, condition, expected) => {
    expect(evaluateCondition(condition, ctx({ a: 'x', n: 10 }))).toBe(expected);
  });

  it('reads the record status through the reserved "status" key', () => {
    const condition: Condition = { op: 'eq', field: 'status', value: 'inactive' };
    expect(evaluateCondition(condition, ctx({}, 'inactive'))).toBe(true);
    expect(evaluateCondition(condition, ctx({}, 'available'))).toBe(false);
  });

  it('treats null as "empty" and compares against null', () => {
    expect(evaluateCondition({ op: 'eq', field: 'a', value: null }, ctx({ a: '' }))).toBe(true);
    expect(evaluateCondition({ op: 'neq', field: 'a', value: null }, ctx({ a: 'x' }))).toBe(true);
  });

  it('matches multiselect values with "in" (any overlap) and never with "eq"', () => {
    const values = ctx({ tags: ['a', 'b'] });
    expect(evaluateCondition({ op: 'in', field: 'tags', values: ['b', 'z'] }, values)).toBe(true);
    expect(evaluateCondition({ op: 'in', field: 'tags', values: ['z'] }, values)).toBe(false);
    expect(evaluateCondition({ op: 'eq', field: 'tags', value: 'a' }, values)).toBe(false);
  });

  it('is false when comparing incomparable types or missing values', () => {
    expect(evaluateCondition({ op: 'gt', field: 'a', value: 1 }, ctx({ a: 'text' }))).toBe(false);
    expect(evaluateCondition({ op: 'gt', field: 'missing', value: 1 }, ctx({}))).toBe(false);
  });

  it('compares ISO dates as text', () => {
    expect(
      evaluateCondition({ op: 'lt', field: 'd', value: '2026-12-31' }, ctx({ d: '2026-06-01' })),
    ).toBe(true);
  });

  it('evaluates deeper-than-allowed conditions as false instead of recursing', () => {
    let deep: Condition = { op: 'eq', field: 'a', value: 'x' };
    for (let i = 0; i < MAX_CONDITION_DEPTH + 2; i++)
      deep = { op: 'not', condition: { op: 'not', condition: deep } };
    expect(conditionDepth(deep)).toBeGreaterThan(MAX_CONDITION_DEPTH);
    expect(evaluateCondition(deep, ctx({ a: 'x' }))).toBe(false);
  });

  it('collects the fields a condition depends on', () => {
    const condition: Condition = {
      op: 'and',
      conditions: [
        { op: 'eq', field: 'a', value: 1 },
        { op: 'not', condition: { op: 'empty', field: 'b' } },
      ],
    };
    expect([...conditionFields(condition)].sort()).toEqual(['a', 'b']);
  });

  it('knows what an empty value is', () => {
    for (const v of [null, undefined, '', []]) expect(isEmptyValue(v)).toBe(true);
    for (const v of [0, false, 'x', ['a']]) expect(isEmptyValue(v)).toBe(false);
  });
});
