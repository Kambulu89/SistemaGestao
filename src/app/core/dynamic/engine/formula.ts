import type { FieldDefinition } from '../models/field-definition.model';

/**
 * Fórmulas declarativas. Uma fórmula é **texto numa gramática restrita** que o motor interpreta;
 * nunca é JavaScript nem se executa código do tenant. Aritmética em ponto fixo (BigInt): sem
 * erros de vírgula flutuante (0,1 + 0,2 = 0,3).
 *
 * Gramática:
 *   expr    := termo (('+' | '-') termo)*
 *   termo   := unário (('*' | '/') unário)*
 *   unário  := '-' unário | primário
 *   primário:= número | campo | função '(' args ')' | '(' expr ')'
 * Funções: round(x, casas), min(a, b, …), max(a, b, …), abs(x).
 */

export type FormulaNode =
  | { readonly kind: 'num'; readonly text: string }
  | { readonly kind: 'ref'; readonly field: string }
  | { readonly kind: 'neg'; readonly operand: FormulaNode }
  | {
      readonly kind: 'bin';
      readonly op: '+' | '-' | '*' | '/';
      readonly left: FormulaNode;
      readonly right: FormulaNode;
    }
  | {
      readonly kind: 'call';
      readonly name: FormulaFunction;
      readonly args: readonly FormulaNode[];
    };

export type FormulaFunction = 'round' | 'min' | 'max' | 'abs';

export type FormulaParse =
  | { readonly ok: true; readonly ast: FormulaNode; readonly refs: readonly string[] }
  | { readonly ok: false; readonly message: string };

const MAX_SOURCE = 500;
const MAX_NODES = 100;
const MAX_DEPTH = 20;
/** Casas decimais internas: o suficiente para multiplicar duas moedas de 6 casas sem perder nada. */
const SCALE = 12;
const ONE = 10n ** BigInt(SCALE);
const FUNCTIONS: readonly string[] = ['round', 'min', 'max', 'abs'];
const MAX_RESULT_SCALE = 10;

type Token =
  | { readonly t: 'num'; readonly text: string }
  | { readonly t: 'id'; readonly text: string }
  | { readonly t: 'op'; readonly text: '+' | '-' | '*' | '/' | '(' | ')' | ',' };

function tokenize(source: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9]/.test(ch)) {
      const match = /^\d+(\.\d+)?/.exec(source.slice(i))!;
      tokens.push({ t: 'num', text: match[0] });
      i += match[0].length;
      if (/[A-Za-z_]/.test(source[i] ?? ''))
        return `Número mal formado perto de "${source.slice(i - match[0].length, i + 1)}".`;
    } else if (/[a-z]/.test(ch)) {
      const match = /^[a-z][A-Za-z0-9]*/.exec(source.slice(i))!;
      tokens.push({ t: 'id', text: match[0] });
      i += match[0].length;
    } else if ('+-*/(),'.includes(ch)) {
      tokens.push({ t: 'op', text: ch as '+' });
      i++;
    } else {
      return `Carácter não permitido "${ch}".`;
    }
  }
  return tokens;
}

/** Analisa a fórmula. Devolve a árvore e os campos referidos, ou a primeira mensagem de erro. */
export function parseFormula(source: string): FormulaParse {
  if (!source.trim()) return { ok: false, message: 'Indique a fórmula.' };
  if (source.length > MAX_SOURCE)
    return { ok: false, message: `A fórmula não pode ter mais de ${MAX_SOURCE} caracteres.` };
  const tokens = tokenize(source);
  if (typeof tokens === 'string') return { ok: false, message: tokens };

  let position = 0;
  let nodes = 0;
  const refs = new Set<string>();
  const fail = (message: string): never => {
    throw new FormulaSyntaxError(message);
  };
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const isOp = (text: string) => {
    const token = peek();
    return token?.t === 'op' && token.text === text;
  };
  const count = (): void => {
    if (++nodes > MAX_NODES) fail(`A fórmula é demasiado complexa (máx. ${MAX_NODES} elementos).`);
  };

  const expression = (depth: number): FormulaNode => {
    if (depth > MAX_DEPTH) fail('A fórmula tem parênteses demasiado aninhados.');
    let left = term(depth);
    while (isOp('+') || isOp('-')) {
      const op = (take() as { text: '+' | '-' }).text;
      count();
      left = { kind: 'bin', op, left, right: term(depth) };
    }
    return left;
  };
  const term = (depth: number): FormulaNode => {
    let left = unary(depth);
    while (isOp('*') || isOp('/')) {
      const op = (take() as { text: '*' | '/' }).text;
      count();
      left = { kind: 'bin', op, left, right: unary(depth) };
    }
    return left;
  };
  const unary = (depth: number): FormulaNode => {
    if (isOp('-')) {
      take();
      count();
      return { kind: 'neg', operand: unary(depth + 1) };
    }
    return primary(depth);
  };
  const primary = (depth: number): FormulaNode => {
    const token = take();
    if (!token) return fail('A fórmula está incompleta.');
    count();
    if (token.t === 'num') return { kind: 'num', text: token.text };
    if (token.t === 'id') {
      if (isOp('(')) {
        if (!FUNCTIONS.includes(token.text))
          return fail(`Função desconhecida "${token.text}" (use round, min, max ou abs).`);
        take();
        const args: FormulaNode[] = [];
        if (!isOp(')')) {
          args.push(expression(depth + 1));
          while (isOp(',')) {
            take();
            args.push(expression(depth + 1));
          }
        }
        if (!isOp(')')) return fail('Falta fechar o parêntese da função.');
        take();
        checkArity(token.text as FormulaFunction, args, fail);
        return { kind: 'call', name: token.text as FormulaFunction, args };
      }
      refs.add(token.text);
      return { kind: 'ref', field: token.text };
    }
    if (token.text === '(') {
      const inner = expression(depth + 1);
      if (!isOp(')')) return fail('Falta fechar um parêntese.');
      take();
      return inner;
    }
    return fail(`Símbolo inesperado "${token.text}".`);
  };

  try {
    const ast = expression(0);
    if (position < tokens.length)
      return fail(`Símbolo inesperado "${(tokens[position] as Token).text}".`);
    return { ok: true, ast, refs: [...refs] };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { ok: false, message: error.message };
    throw error;
  }
}

class FormulaSyntaxError extends Error {}

function checkArity(
  name: FormulaFunction,
  args: readonly FormulaNode[],
  fail: (message: string) => never,
): void {
  if (name === 'abs' && args.length !== 1) fail('abs() recebe um único valor.');
  if ((name === 'min' || name === 'max') && args.length < 2)
    fail(`${name}() recebe pelo menos dois valores.`);
  if (name === 'round') {
    const digits = args[1];
    if (args.length !== 2 || digits?.kind !== 'num' || !/^\d+$/.test(digits.text))
      return fail(
        'round() recebe um valor e as casas decimais (um inteiro literal), ex.: round(x, 2).',
      );
    if (Number(digits.text) > MAX_RESULT_SCALE)
      fail(`round() admite no máximo ${MAX_RESULT_SCALE} casas decimais.`);
  }
}

// ------------------------------------------------------------------ aritmética em ponto fixo

class DivisionByZero extends Error {}

/** Texto decimal → inteiro escalado, exacto. Mais de `SCALE` casas são arredondadas. */
function toFixed(text: string): bigint {
  const negative = text.startsWith('-');
  const [int = '0', frac = ''] = text.replace('-', '').split('.');
  const padded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
  const rounding = frac.length > SCALE && frac.charCodeAt(SCALE) >= 53 ? 1n : 0n; // '5'
  const value = BigInt(int) * ONE + BigInt(padded || '0') + rounding;
  return negative ? -value : value;
}

/** Número JS → texto decimal sem notação científica (a representação mais curta que o identifica). */
function numberToText(value: number): string {
  const text = String(value);
  return /e/i.test(text) ? value.toFixed(SCALE) : text;
}

const divRound = (a: bigint, b: bigint): bigint => {
  // Divisão com arredondamento "meio afastado de zero".
  const negative = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (2n * x + y) / (2n * y);
  return negative ? -q : q;
};

function roundTo(value: bigint, digits: number): bigint {
  const unit = 10n ** BigInt(SCALE - digits);
  return divRound(value, unit) * unit;
}

const compare = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

function evaluate(node: FormulaNode, valueOf: (field: string) => number | null): bigint | null {
  switch (node.kind) {
    case 'num':
      return toFixed(node.text);
    case 'ref': {
      const value = valueOf(node.field);
      // Fora do intervalo seguro não há exactidão a garantir: o resultado fica vazio.
      return value === null || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER
        ? null
        : toFixed(numberToText(value));
    }
    case 'neg': {
      const v = evaluate(node.operand, valueOf);
      return v === null ? null : -v;
    }
    case 'bin': {
      const a = evaluate(node.left, valueOf);
      const b = evaluate(node.right, valueOf);
      if (a === null || b === null) return null;
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return divRound(a * b, ONE);
      if (b === 0n) throw new DivisionByZero();
      return divRound(a * ONE, b);
    }
    case 'call': {
      if (node.name === 'round') {
        const v = evaluate(node.args[0]!, valueOf);
        return v === null ? null : roundTo(v, Number((node.args[1] as { text: string }).text));
      }
      const values = node.args.map((a) => evaluate(a, valueOf));
      if (values.some((v) => v === null)) return null;
      const list = values as bigint[];
      if (node.name === 'abs') return list[0]! < 0n ? -list[0]! : list[0]!;
      return list.reduce((best, v) =>
        (node.name === 'min' ? compare(v, best) < 0 : compare(v, best) > 0) ? v : best,
      );
    }
  }
}

/**
 * Calcula a fórmula. Devolve `null` se algum valor em falta entrar na conta ou se houver uma
 * divisão por zero. O resultado é arredondado a `scale` casas (meio afastado de zero).
 */
export function evaluateFormula(
  ast: FormulaNode,
  valueOf: (field: string) => number | null,
  scale: number,
): number | null {
  try {
    const raw = evaluate(ast, valueOf);
    if (raw === null) return null;
    const rounded = roundTo(raw, Math.min(Math.max(scale, 0), MAX_RESULT_SCALE));
    const negative = rounded < 0n;
    const abs = negative ? -rounded : rounded;
    const int = abs / ONE;
    if (int > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const frac = String(abs % ONE)
      .padStart(SCALE, '0')
      .slice(0, scale)
      .replace(/0+$/, '');
    const number = Number(`${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`);
    return Object.is(number, -0) ? 0 : number;
  } catch (error) {
    if (error instanceof DivisionByZero) return null;
    throw error;
  }
}

// ------------------------------------------------------------------ dependências

type FormulaField = Extract<FieldDefinition, { type: 'formula' }>;

/** Campos de uma entidade que são fórmulas (activos). */
export const formulaFields = (fields: readonly FieldDefinition[]): FormulaField[] =>
  fields.filter((f): f is FormulaField => f.type === 'formula' && !f.archived);

/** Campos referidos por cada fórmula (ignora fórmulas inválidas). */
export function formulaDependencies(fields: readonly FieldDefinition[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const field of formulaFields(fields)) {
    const parsed = parseFormula(field.formula.source);
    result.set(field.key, parsed.ok ? [...parsed.refs] : []);
  }
  return result;
}

export interface FormulaOrder {
  /** Fórmulas por ordem de cálculo (as dependências primeiro). */
  readonly order: readonly string[];
  /** Fórmulas envolvidas num ciclo (não se calculam). */
  readonly cyclic: ReadonlySet<string>;
}

/** Ordenação topológica das fórmulas, com detecção de ciclos (A → B → A, ou A → A). */
export function orderFormulas(fields: readonly FieldDefinition[]): FormulaOrder {
  const deps = formulaDependencies(fields);
  const order: string[] = [];
  const cyclic = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (key: string, stack: string[]): void => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      for (const member of stack.slice(stack.indexOf(key))) cyclic.add(member);
      return;
    }
    state.set(key, 'visiting');
    for (const dep of deps.get(key) ?? []) if (deps.has(dep)) visit(dep, [...stack, key]);
    state.set(key, 'done');
    order.push(key);
  };
  for (const key of deps.keys()) visit(key, []);
  return { order: order.filter((k) => !cyclic.has(k)), cyclic };
}

/**
 * Calcula todas as fórmulas de uma entidade sobre os dados de um registo. Não altera `data`:
 * devolve só os valores das fórmulas. Os campos em ciclo ficam vazios.
 */
export function computeFormulas(
  fields: readonly FieldDefinition[],
  data: Readonly<Record<string, unknown>>,
): Record<string, number | null> {
  const results: Record<string, number | null> = {};
  const byKey = new Map(formulaFields(fields).map((f) => [f.key, f]));
  const { order, cyclic } = orderFormulas(fields);
  for (const key of cyclic) results[key] = null;

  const valueOf = (field: string): number | null => {
    if (Object.hasOwn(results, field)) return results[field] ?? null;
    const value = Object.hasOwn(data, field) ? data[field] : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  for (const key of order) {
    const field = byKey.get(key)!;
    const parsed = parseFormula(field.formula.source);
    results[key] = parsed.ok ? evaluateFormula(parsed.ast, valueOf, field.scale) : null;
  }
  return results;
}
