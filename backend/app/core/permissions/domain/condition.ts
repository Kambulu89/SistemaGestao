/**
 * Condições ABAC **declarativas** (AST em JSON). Nunca se executa código, SQL nem expressões do tenant:
 * só estes nós, com variáveis de uma lista fechada (`subject`, `resource`, `env`) e comparações.
 */
export type Literal = string | number | boolean | null
export type Operand = { var: string } | { value: Literal | Literal[] }

export type Condition =
  | { op: 'true' }
  | { op: 'and' | 'or'; args: Condition[] }
  | { op: 'not'; arg: Condition }
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'; left: Operand; right: Operand }
  | { op: 'exists'; arg: Operand }

export interface EvalContext {
  subject: Record<string, unknown>
  resource: Record<string, unknown>
  env: Record<string, unknown>
}

export const CONDITION_ROOTS = ['subject', 'resource', 'env'] as const
const MAX_DEPTH = 8
const MAX_NODES = 50
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const COMPARISONS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'] as const

export interface ConditionIssue {
  path: string
  code: string
  message: string
}

export class ConditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConditionError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isLiteral = (value: unknown): value is Literal =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

function validateOperand(operand: unknown, path: string, issues: ConditionIssue[]) {
  if (!isRecord(operand)) {
    issues.push({ path, code: 'INVALID_OPERAND', message: 'Operando inválido.' })
    return
  }
  if ('var' in operand) {
    const name = operand.var
    const segments = typeof name === 'string' ? name.split('.') : []
    const [root, ...rest] = segments
    const ok =
      (CONDITION_ROOTS as readonly string[]).includes(root) &&
      rest.length > 0 &&
      rest.length <= 4 &&
      segments.every((s, i) => i === 0 || SEGMENT.test(s))
    if (!ok) {
      issues.push({
        path: `${path}.var`,
        code: 'INVALID_VARIABLE',
        message: 'A variável tem de começar por subject., resource. ou env.',
      })
    }
    return
  }
  if ('value' in operand) {
    const value = operand.value
    const valid = Array.isArray(value)
      ? value.length <= 100 && value.every(isLiteral)
      : isLiteral(value)
    if (!valid)
      issues.push({ path: `${path}.value`, code: 'INVALID_VALUE', message: 'Valor inválido.' })
    return
  }
  issues.push({ path, code: 'INVALID_OPERAND', message: 'Operando inválido.' })
}

/** Valida a estrutura, a profundidade e o tamanho. Devolve a lista de problemas (vazia = válida). */
export function validateCondition(ast: unknown): ConditionIssue[] {
  const issues: ConditionIssue[] = []
  let nodes = 0

  const visit = (node: unknown, path: string, depth: number) => {
    nodes += 1
    if (depth > MAX_DEPTH) {
      issues.push({ path, code: 'TOO_DEEP', message: `Profundidade máxima: ${MAX_DEPTH}.` })
      return
    }
    if (nodes > MAX_NODES) {
      if (nodes === MAX_NODES + 1) {
        issues.push({ path, code: 'TOO_LARGE', message: `Máximo de ${MAX_NODES} nós.` })
      }
      return
    }
    if (!isRecord(node) || typeof node.op !== 'string') {
      issues.push({ path, code: 'INVALID_NODE', message: 'Nó inválido.' })
      return
    }
    const op = node.op
    if (op === 'true') return
    if (op === 'and' || op === 'or') {
      const args = node.args
      if (!Array.isArray(args) || args.length < 1 || args.length > 20) {
        issues.push({
          path: `${path}.args`,
          code: 'INVALID_ARGS',
          message: 'Indique 1 a 20 condições.',
        })
        return
      }
      args.forEach((arg, i) => visit(arg, `${path}.args[${i}]`, depth + 1))
      return
    }
    if (op === 'not') {
      visit(node.arg, `${path}.arg`, depth + 1)
      return
    }
    if ((COMPARISONS as readonly string[]).includes(op)) {
      validateOperand(node.left, `${path}.left`, issues)
      validateOperand(node.right, `${path}.right`, issues)
      if (op === 'in' && !(isRecord(node.right) && Array.isArray(node.right.value))) {
        issues.push({
          path: `${path}.right`,
          code: 'IN_NEEDS_LIST',
          message: '"in" exige uma lista de valores.',
        })
      }
      return
    }
    if (op === 'exists') {
      validateOperand(node.arg, `${path}.arg`, issues)
      return
    }
    issues.push({ path, code: 'UNKNOWN_OP', message: `Operador desconhecido: ${op}.` })
  }

  visit(ast, '$', 1)
  return issues
}

function lookup(name: string, context: EvalContext): unknown {
  const [root, ...path] = name.split('.')
  if (!(CONDITION_ROOTS as readonly string[]).includes(root)) {
    throw new ConditionError(`Variável desconhecida: ${name}`)
  }
  let current: unknown = context[root as keyof EvalContext]
  for (const segment of path) {
    // Só propriedades próprias: nunca `__proto__`, `constructor`, etc.
    if (!SEGMENT.test(segment) || !isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

const resolve = (operand: Operand, context: EvalContext): unknown =>
  'var' in operand ? lookup(operand.var, context) : operand.value

const DECIMAL = /^-?\d+(\.\d+)?$/

/** Compara números e decimais em string (dinheiro/quantidades) sem passar por float. */
function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b)
  if (typeof a === 'string' && typeof b === 'string') {
    if (DECIMAL.test(a) && DECIMAL.test(b)) {
      const scale = (value: string) => {
        const negative = value.startsWith('-')
        const [int, frac = ''] = value.replace('-', '').split('.')
        const scaled = BigInt(int + frac.padEnd(12, '0').slice(0, 12))
        return negative ? -scaled : scaled
      }
      const [x, y] = [scale(a), scale(b)]
      return x === y ? 0 : x < y ? -1 : 1
    }
    return a === b ? 0 : a < b ? -1 : 1
  }
  return null
}

/** Avalia a condição. Estruturas inválidas lançam `ConditionError` (quem chama decide, falhando fechado). */
export function evaluateCondition(condition: Condition, context: EvalContext): boolean {
  const issues = validateCondition(condition)
  if (issues.length > 0) throw new ConditionError(issues[0].message)
  return run(condition, context)
}

function run(node: Condition, context: EvalContext): boolean {
  switch (node.op) {
    case 'true':
      return true
    case 'and':
      return node.args.every((arg) => run(arg, context))
    case 'or':
      return node.args.some((arg) => run(arg, context))
    case 'not':
      return !run(node.arg, context)
    case 'exists': {
      const value = resolve(node.arg, context)
      return value !== undefined && value !== null
    }
    case 'in': {
      const list = resolve(node.right, context)
      const value = resolve(node.left, context)
      return Array.isArray(list) && value !== undefined && list.includes(value as Literal)
    }
    default: {
      const left = resolve(node.left, context)
      const right = resolve(node.right, context)
      if (left === undefined || right === undefined) return false
      if (node.op === 'eq') return left === right
      if (node.op === 'neq') return left !== right
      const order = compare(left, right)
      if (order === null) return false
      return node.op === 'gt'
        ? order > 0
        : node.op === 'gte'
          ? order >= 0
          : node.op === 'lt'
            ? order < 0
            : order <= 0
    }
  }
}
