/**
 * Construtor das condições das políticas de acesso (ABAC). O servidor guarda uma AST declarativa (nunca código): aqui só
 * se constrói a forma mais comum — comparações de `subject.*`, `resource.*` e `env.*` com valores literais, ligadas por «e»
 * ou «ou». Uma condição mais rica (aninhada, negações…) não se perde: mostra-se só de leitura e só se substitui se a
 * pessoa a refizer.
 */
export type Root = 'subject' | 'resource' | 'env';
export type Operator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'filled' | 'empty';
export type ValueType = 'text' | 'number' | 'boolean';

export const ROOTS: readonly { value: Root; label: string }[] = [
  { value: 'subject', label: 'Quem pede (subject)' },
  { value: 'resource', label: 'O recurso (resource)' },
  { value: 'env', label: 'O ambiente (env)' },
];

export const OPERATORS: readonly { value: Operator; label: string }[] = [
  { value: 'eq', label: 'é igual a' },
  { value: 'neq', label: 'é diferente de' },
  { value: 'gt', label: 'é maior que' },
  { value: 'gte', label: 'é maior ou igual a' },
  { value: 'lt', label: 'é menor que' },
  { value: 'lte', label: 'é menor ou igual a' },
  { value: 'in', label: 'está em (lista separada por vírgulas)' },
  { value: 'filled', label: 'está preenchido' },
  { value: 'empty', label: 'está vazio' },
];

export const VALUE_TYPES: readonly { value: ValueType; label: string }[] = [
  { value: 'text', label: 'Texto' },
  { value: 'number', label: 'Número' },
  { value: 'boolean', label: 'Verdadeiro/falso' },
];

export interface Clause {
  readonly root: Root;
  /** Caminho depois da raiz (`unitId`, `amount`, `owner.id`…): letras, números e _ por segmento, até 4. */
  readonly path: string;
  readonly operator: Operator;
  readonly type: ValueType;
  /** Texto escrito; convertido para o tipo ao gerar a AST. Ignorado em «preenchido/vazio». */
  readonly value: string;
}

export interface ConditionDraft {
  readonly join: 'and' | 'or';
  readonly clauses: readonly Clause[];
}

type Literal = string | number | boolean | null;
type Operand = { var: string } | { value: Literal | Literal[] };
interface Ast {
  readonly op: string;
  readonly [key: string]: unknown;
}

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMPARISONS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']);
const ROOT_SET = new Set<string>(['subject', 'resource', 'env']);

const isAst = (value: unknown): value is Ast =>
  typeof value === 'object' && value !== null && typeof (value as Ast).op === 'string';

export function isValidPath(path: string): boolean {
  const segments = path.split('.');
  return segments.length >= 1 && segments.length <= 4 && segments.every((s) => SEGMENT.test(s));
}

/** Texto → valor do tipo escolhido; `undefined` se não for válido para o tipo. */
export function literalOf(text: string, type: ValueType): Literal | undefined {
  const trimmed = text.trim();
  if (type === 'boolean')
    return trimmed === 'true' ? true : trimmed === 'false' ? false : undefined;
  if (type === 'number') {
    return trimmed !== '' && Number.isFinite(Number(trimmed)) ? Number(trimmed) : undefined;
  }
  return trimmed === '' ? undefined : trimmed;
}

function clauseToAst(clause: Clause): Ast | null {
  if (!isValidPath(clause.path)) return null;
  const operand: Operand = { var: `${clause.root}.${clause.path}` };
  if (clause.operator === 'filled') return { op: 'exists', arg: operand };
  if (clause.operator === 'empty') return { op: 'not', arg: { op: 'exists', arg: operand } };
  if (clause.operator === 'in') {
    const items = clause.value.split(',').map((item) => literalOf(item, clause.type));
    if (items.length === 0 || items.some((item) => item === undefined)) return null;
    return { op: 'in', left: operand, right: { value: items as Literal[] } };
  }
  const literal = literalOf(clause.value, clause.type);
  if (literal === undefined) return null;
  return { op: clause.operator, left: operand, right: { value: literal } };
}

export type BuildResult =
  { readonly ok: true; readonly ast: Ast } | { readonly ok: false; readonly message: string };

export function buildPolicyCondition(draft: ConditionDraft): BuildResult {
  if (draft.clauses.length === 0) return { ok: false, message: 'Indique pelo menos uma condição.' };
  const parts: Ast[] = [];
  for (const [index, clause] of draft.clauses.entries()) {
    if (!isValidPath(clause.path)) {
      return {
        ok: false,
        message: `Condição ${index + 1}: o caminho (ex.: unitId, amount, owner.id) tem letras, números e _.`,
      };
    }
    const ast = clauseToAst(clause);
    if (!ast) return { ok: false, message: `Condição ${index + 1}: valor inválido para o tipo.` };
    parts.push(ast);
  }
  return { ok: true, ast: parts.length === 1 ? parts[0]! : { op: draft.join, args: parts } };
}

function varOf(operand: unknown): { root: Root; path: string } | null {
  const v = (operand as { var?: unknown } | null)?.var;
  if (typeof v !== 'string') return null;
  const [root, ...rest] = v.split('.');
  if (!root || !ROOT_SET.has(root) || rest.length === 0) return null;
  return { root: root as Root, path: rest.join('.') };
}

function literalToClause(value: Literal | Literal[]): { type: ValueType; text: string } | null {
  const sample = Array.isArray(value) ? value[0] : value;
  const type: ValueType =
    typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'text';
  if (sample === null) return null;
  const text = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  return { type, text };
}

function clauseOfAst(node: unknown): Clause | null {
  if (!isAst(node)) return null;
  if (node.op === 'exists') {
    const v = varOf(node['arg']);
    return v ? { ...v, operator: 'filled', type: 'text', value: '' } : null;
  }
  if (node.op === 'not' && isAst(node['arg']) && node['arg'].op === 'exists') {
    const v = varOf(node['arg']['arg']);
    return v ? { ...v, operator: 'empty', type: 'text', value: '' } : null;
  }
  if (COMPARISONS.has(node.op)) {
    const v = varOf(node['left']);
    const right = node['right'] as { value?: Literal | Literal[] } | undefined;
    if (!v || !right || !('value' in right) || right.value === undefined) return null;
    const literal = literalToClause(right.value);
    if (!literal) return null;
    return { ...v, operator: node.op as Operator, type: literal.type, value: literal.text };
  }
  return null;
}

/** AST → rascunho do construtor; `null` quando a condição é mais rica do que o construtor sabe representar. */
export function parsePolicyCondition(ast: unknown): ConditionDraft | null {
  if (!isAst(ast)) return null;
  if (ast.op === 'and' || ast.op === 'or') {
    const args = ast['args'];
    if (!Array.isArray(args) || args.length < 2) return null;
    const clauses = args.map(clauseOfAst);
    return clauses.every((c): c is Clause => c !== null) ? { join: ast.op, clauses } : null;
  }
  const single = clauseOfAst(ast);
  return single ? { join: 'and', clauses: [single] } : null;
}

/** Descrição curta e legível; para uma condição que o construtor não representa, devolve «condição avançada». */
export function describePolicyCondition(ast: unknown): string {
  if (ast === null || ast === undefined) return 'sempre';
  const draft = parsePolicyCondition(ast);
  if (!draft) return 'condição avançada';
  const parts = draft.clauses.map((c) => {
    const operator =
      OPERATORS.find((o) => o.value === c.operator)?.label.split(' (')[0] ?? c.operator;
    const needsValue = c.operator !== 'filled' && c.operator !== 'empty';
    return `${c.root}.${c.path} ${operator}${needsValue ? ` ${c.value}` : ''}`;
  });
  return parts.join(draft.join === 'and' ? ' e ' : ' ou ');
}
