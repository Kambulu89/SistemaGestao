/**
 * Construtor de condições de regras. A API guarda a condição como AST declarativa (a mesma das políticas
 * de acesso); o editor só constrói a forma mais comum: comparações de campos do registo ligadas por «e» ou
 * «ou». Uma condição mais rica (aninhada, sobre o utilizador ou o tempo) não se perde: mostra-se em
 * só de leitura e só se substitui se a pessoa a refizer.
 */

export type ClauseOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'filled' | 'empty';

export const CLAUSE_OPERATORS: readonly { value: ClauseOperator; label: string }[] = [
  { value: 'eq', label: 'é igual a' },
  { value: 'neq', label: 'é diferente de' },
  { value: 'gt', label: 'é maior que' },
  { value: 'gte', label: 'é maior ou igual a' },
  { value: 'lt', label: 'é menor que' },
  { value: 'lte', label: 'é menor ou igual a' },
  { value: 'filled', label: 'está preenchido' },
  { value: 'empty', label: 'está vazio' },
];

export interface Clause {
  /** Código do campo no servidor (`snake_case`). */
  readonly field: string;
  readonly operator: ClauseOperator;
  /** Texto escrito; convertido para o tipo do campo ao gerar a AST. Ignorado em «preenchido/vazio». */
  readonly value: string;
}

export interface ConditionDraft {
  readonly join: 'and' | 'or';
  readonly clauses: readonly Clause[];
}

/** Como um campo guarda os valores que a regra compara. */
export type ValueKind = 'number' | 'decimal' | 'boolean' | 'text';

type Literal = string | number | boolean | null;
type Operand = { var: string } | { value: Literal | Literal[] };
interface Ast {
  readonly op: string;
  readonly [key: string]: unknown;
}

const COMPARISONS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const RESOURCE = 'resource.';

const isAst = (value: unknown): value is Ast =>
  typeof value === 'object' && value !== null && typeof (value as Ast).op === 'string';

/** Converte o texto escrito no valor que o servidor compara; `null` quando não é válido para o tipo. */
export function literalOf(text: string, kind: ValueKind): Literal | undefined {
  const trimmed = text.trim();
  switch (kind) {
    case 'boolean':
      return trimmed === 'true' ? true : trimmed === 'false' ? false : undefined;
    case 'number': {
      if (trimmed === '' || !Number.isFinite(Number(trimmed))) return undefined;
      return Number(trimmed);
    }
    case 'decimal':
      // Os decimais atravessam a API como texto: nunca como número.
      return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : undefined;
    case 'text':
      return trimmed === '' ? undefined : trimmed;
  }
}

function clauseToAst(clause: Clause, kind: ValueKind): Ast | null {
  const operand: Operand = { var: `${RESOURCE}${clause.field}` };
  if (clause.operator === 'filled') return { op: 'exists', arg: operand };
  if (clause.operator === 'empty') return { op: 'not', arg: { op: 'exists', arg: operand } };
  const literal = literalOf(clause.value, kind);
  if (literal === undefined) return null;
  return { op: clause.operator, left: operand, right: { value: literal } };
}

export type BuildResult =
  { readonly ok: true; readonly ast: Ast } | { readonly ok: false; readonly message: string };

/** Rascunho do construtor → AST; recusa o que não é um valor válido para o tipo do campo. */
export function buildCondition(
  draft: ConditionDraft,
  kindOf: (field: string) => ValueKind | undefined,
): BuildResult {
  if (draft.clauses.length === 0) return { ok: false, message: 'Indique pelo menos uma condição.' };
  const parts: Ast[] = [];
  for (const [index, clause] of draft.clauses.entries()) {
    const kind = kindOf(clause.field);
    if (!clause.field || !kind)
      return { ok: false, message: `Condição ${index + 1}: escolha um campo.` };
    const ast = clauseToAst(clause, kind);
    if (!ast) return { ok: false, message: `Condição ${index + 1}: valor inválido para o campo.` };
    parts.push(ast);
  }
  return { ok: true, ast: parts.length === 1 ? parts[0]! : { op: draft.join, args: parts } };
}

function textOf(value: Literal | Literal[]): string | null {
  return Array.isArray(value) || value === null ? null : String(value);
}

function clauseOfAst(node: unknown): Clause | null {
  if (!isAst(node)) return null;
  const field = (operand: unknown): string | null => {
    const v = (operand as { var?: unknown } | null)?.var;
    return typeof v === 'string' && v.startsWith(RESOURCE) ? v.slice(RESOURCE.length) : null;
  };
  if (node.op === 'exists') {
    const f = field(node['arg']);
    return f ? { field: f, operator: 'filled', value: '' } : null;
  }
  if (node.op === 'not' && isAst(node['arg']) && node['arg'].op === 'exists') {
    const f = field(node['arg']['arg']);
    return f ? { field: f, operator: 'empty', value: '' } : null;
  }
  if (COMPARISONS.has(node.op)) {
    const f = field(node['left']);
    const right = node['right'] as { value?: Literal | Literal[] } | undefined;
    if (!f || !right || !('value' in right)) return null;
    const text = textOf(right.value as Literal | Literal[]);
    return text === null ? null : { field: f, operator: node.op as ClauseOperator, value: text };
  }
  return null;
}

/** AST → rascunho do construtor; `null` quando a condição é mais rica do que o construtor sabe representar. */
export function parseCondition(ast: unknown): ConditionDraft | null {
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
