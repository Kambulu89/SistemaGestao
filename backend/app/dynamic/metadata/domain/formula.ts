import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'

/**
 * Fórmulas declarativas (C10/C12). Uma fórmula é **texto numa gramática restrita** que se converte numa árvore
 * (AST) guardada na versão do campo; nunca é código do tenant (sem `eval`, sem acesso ao sistema, à rede ou ao SQL).
 * Aritmética em ponto fixo com `BigInt` (0,1 + 0,2 = 0,3) e custo limitado pela dimensão da árvore.
 *
 *   expr     := termo (('+' | '-') termo)*
 *   termo    := unário (('*' | '/') unário)*
 *   unário   := '-' unário | primário
 *   primário := número | campo | função '(' args ')' | '(' expr ')'
 * Funções: round(x, casas), min(a, b, …), max(a, b, …), abs(x).
 *
 * Nulos e divisão por zero: se um valor em falta entra na conta, ou há uma divisão por zero, o resultado é
 * **vazio** (nunca zero); um resultado que não cabe em 19 dígitos também fica vazio.
 */
export type FormulaNode =
  | { kind: 'num'; text: string }
  | { kind: 'ref'; field: string }
  | { kind: 'neg'; operand: FormulaNode }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
  | { kind: 'call'; name: FormulaFunction; args: FormulaNode[] }

export type FormulaFunction = 'round' | 'min' | 'max' | 'abs'
export type FormulaParse =
  { ok: true; ast: FormulaNode; refs: string[] } | { ok: false; message: string }

export const FORMULA_MAX_SOURCE = 500
export const FORMULA_MAX_NODES = 100
const MAX_DEPTH = 20
export const FORMULA_MAX_SCALE = 10
const MAX_RESULT_DIGITS = 19
/** Casas internas: chega para multiplicar dois decimais de 6 casas sem perder nada. */
const SCALE = 12
const ONE = 10n ** BigInt(SCALE)
const FUNCTIONS: readonly string[] = ['round', 'min', 'max', 'abs']

type Token = { t: 'num' | 'id'; text: string } | { t: 'op'; text: string }

function tokenize(source: string): Token[] | string {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i] as string
    if (/\s/.test(ch)) {
      i++
    } else if (/[0-9]/.test(ch)) {
      const match = /^\d+(\.\d+)?/.exec(source.slice(i)) as RegExpExecArray
      tokens.push({ t: 'num', text: match[0] })
      i += match[0].length
      if (/[A-Za-z_]/.test(source[i] ?? '')) return `Número mal formado perto de "${match[0]}".`
    } else if (/[a-z]/.test(ch)) {
      const match = /^[a-z][a-z0-9_]*/.exec(source.slice(i)) as RegExpExecArray
      tokens.push({ t: 'id', text: match[0] })
      i += match[0].length
    } else if ('+-*/(),'.includes(ch)) {
      tokens.push({ t: 'op', text: ch })
      i++
    } else {
      return `Carácter não permitido "${ch}".`
    }
  }
  return tokens
}

class SyntaxProblem extends Error {}

/** Analisa a fórmula: devolve a árvore e os campos referidos, ou a primeira mensagem de erro. */
export function parseFormula(source: string): FormulaParse {
  if (!source.trim()) return { ok: false, message: 'Indique a fórmula.' }
  if (source.length > FORMULA_MAX_SOURCE) {
    return {
      ok: false,
      message: `A fórmula não pode ter mais de ${FORMULA_MAX_SOURCE} caracteres.`,
    }
  }
  const tokens = tokenize(source)
  if (typeof tokens === 'string') return { ok: false, message: tokens }

  let position = 0
  let nodes = 0
  const refs = new Set<string>()
  const fail = (message: string): never => {
    throw new SyntaxProblem(message)
  }
  const isOp = (text: string) => {
    const token = tokens[position]
    return token?.t === 'op' && token.text === text
  }
  const count = () => {
    if (++nodes > FORMULA_MAX_NODES) {
      fail(`A fórmula é demasiado complexa (máx. ${FORMULA_MAX_NODES} elementos).`)
    }
  }

  const expression = (depth: number): FormulaNode => {
    if (depth > MAX_DEPTH) fail('A fórmula tem parênteses demasiado aninhados.')
    let left = term(depth)
    while (isOp('+') || isOp('-')) {
      const op = (tokens[position++] as Token).text as '+' | '-'
      count()
      left = { kind: 'bin', op, left, right: term(depth) }
    }
    return left
  }
  const term = (depth: number): FormulaNode => {
    let left = unary(depth)
    while (isOp('*') || isOp('/')) {
      const op = (tokens[position++] as Token).text as '*' | '/'
      count()
      left = { kind: 'bin', op, left, right: unary(depth) }
    }
    return left
  }
  const unary = (depth: number): FormulaNode => {
    if (isOp('-')) {
      position++
      count()
      if (depth > MAX_DEPTH) fail('A fórmula tem demasiados sinais encadeados.')
      return { kind: 'neg', operand: unary(depth + 1) }
    }
    return primary(depth)
  }
  const primary = (depth: number): FormulaNode => {
    const token = tokens[position++]
    if (!token) return fail('A fórmula está incompleta.')
    count()
    if (token.t === 'num') return { kind: 'num', text: token.text }
    if (token.t === 'id') {
      if (isOp('(')) {
        if (!FUNCTIONS.includes(token.text)) {
          return fail(`Função desconhecida "${token.text}" (use round, min, max ou abs).`)
        }
        position++
        const args: FormulaNode[] = []
        if (!isOp(')')) {
          args.push(expression(depth + 1))
          while (isOp(',')) {
            position++
            args.push(expression(depth + 1))
          }
        }
        if (!isOp(')')) return fail('Falta fechar o parêntese da função.')
        position++
        checkArity(token.text as FormulaFunction, args)
        return { kind: 'call', name: token.text as FormulaFunction, args }
      }
      refs.add(token.text)
      return { kind: 'ref', field: token.text }
    }
    if (token.text === '(') {
      const inner = expression(depth + 1)
      if (!isOp(')')) return fail('Falta fechar um parêntese.')
      position++
      return inner
    }
    return fail(`Símbolo inesperado "${token.text}".`)
  }

  const checkArity = (name: FormulaFunction, args: FormulaNode[]) => {
    if (name === 'abs' && args.length !== 1) fail('abs() recebe um único valor.')
    if ((name === 'min' || name === 'max') && args.length < 2) {
      fail(`${name}() recebe pelo menos dois valores.`)
    }
    if (name === 'round') {
      const digits = args[1]
      if (args.length !== 2 || digits?.kind !== 'num' || !/^\d+$/.test(digits.text)) {
        fail('round() recebe um valor e as casas decimais (um inteiro literal), ex.: round(x, 2).')
      } else if (Number(digits.text) > FORMULA_MAX_SCALE) {
        fail(`round() admite no máximo ${FORMULA_MAX_SCALE} casas decimais.`)
      }
    }
  }

  try {
    const ast = expression(0)
    if (position < tokens.length) {
      return { ok: false, message: `Símbolo inesperado "${(tokens[position] as Token).text}".` }
    }
    return { ok: true, ast, refs: [...refs] }
  } catch (error) {
    if (error instanceof SyntaxProblem) return { ok: false, message: error.message }
    throw error
  }
}

// --- aritmética em ponto fixo -------------------------------------------------------------------

/** Texto decimal → inteiro escalado, exacto (mais de `SCALE` casas arredondam). */
function toScaled(text: string): bigint {
  const negative = text.startsWith('-')
  const [int = '0', frac = ''] = text.replace('-', '').split('.')
  const padded = (frac + '0'.repeat(SCALE)).slice(0, SCALE)
  const rounding = frac.length > SCALE && (frac.codePointAt(SCALE) as number) >= 53 ? 1n : 0n
  const value = BigInt(int) * ONE + BigInt(padded || '0') + rounding
  return negative ? -value : value
}

/** Divisão com arredondamento «meio afastado de zero». */
function divRound(a: bigint, b: bigint): bigint {
  const negative = a < 0n !== b < 0n
  const x = a < 0n ? -a : a
  const y = b < 0n ? -b : b
  const q = (2n * x + y) / (2n * y)
  return negative ? -q : q
}

function roundTo(value: bigint, digits: number): bigint {
  const unit = 10n ** BigInt(SCALE - digits)
  return divRound(value, unit) * unit
}

class DivisionByZero extends Error {}

function evaluateNode(node: FormulaNode, valueOf: (field: string) => bigint | null): bigint | null {
  switch (node.kind) {
    case 'num':
      return toScaled(node.text)
    case 'ref':
      return valueOf(node.field)
    case 'neg': {
      const value = evaluateNode(node.operand, valueOf)
      return value === null ? null : -value
    }
    case 'bin': {
      const a = evaluateNode(node.left, valueOf)
      const b = evaluateNode(node.right, valueOf)
      if (a === null || b === null) return null
      if (node.op === '+') return a + b
      if (node.op === '-') return a - b
      if (node.op === '*') return divRound(a * b, ONE)
      if (b === 0n) throw new DivisionByZero()
      return divRound(a * ONE, b)
    }
    case 'call': {
      if (node.name === 'round') {
        const value = evaluateNode(node.args[0] as FormulaNode, valueOf)
        const digits = Number((node.args[1] as { text: string }).text)
        return value === null ? null : roundTo(value, digits)
      }
      const values = node.args.map((arg) => evaluateNode(arg, valueOf))
      if (values.includes(null)) return null
      const list = values as bigint[]
      if (node.name === 'abs')
        return (list[0] as bigint) < 0n ? -(list[0] as bigint) : (list[0] as bigint)
      return list.reduce((best, v) => ((node.name === 'min' ? v < best : v > best) ? v : best))
    }
  }
}

/** Valor de um campo numérico (inteiro ou decimal em texto) como inteiro escalado; vazio ou inválido = `null`. */
export function scaledOf(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? toScaled(String(value)) : null
  return typeof value === 'string' && /^-?\d{1,19}(\.\d{1,19})?$/.test(value)
    ? toScaled(value)
    : null
}

/**
 * Calcula a fórmula e devolve o decimal canónico com `scale` casas, ou `null` (valor em falta, divisão por
 * zero ou resultado fora de 19 dígitos).
 */
export function evaluateFormula(
  ast: FormulaNode,
  valueOf: (field: string) => bigint | null,
  scale: number
): string | null {
  let raw: bigint | null
  try {
    raw = evaluateNode(ast, valueOf)
  } catch (error) {
    if (error instanceof DivisionByZero) return null
    throw error
  }
  if (raw === null) return null
  const rounded = roundTo(raw, Math.min(Math.max(scale, 0), FORMULA_MAX_SCALE))
  const negative = rounded < 0n
  const abs = negative ? -rounded : rounded
  const int = (abs / ONE).toString()
  if (int.length + scale > MAX_RESULT_DIGITS) return null
  const frac = (abs % ONE).toString().padStart(SCALE, '0').slice(0, scale)
  const text = `${int}${scale > 0 ? `.${frac}` : ''}`
  return negative && /[1-9]/.test(text) ? `-${text}` : text
}

// --- conjunto de fórmulas de uma versão ---------------------------------------------------------

export interface StoredFormula {
  expression: string
  scale: number
  ast: FormulaNode
  dependencies: string[]
}

/** A fórmula guardada no campo, ou `null` se o campo não é uma fórmula. */
export function formulaOf(spec: FieldSpec): StoredFormula | null {
  if (spec.type !== 'FORMULA') return null
  return spec.validation as unknown as StoredFormula
}

const NUMERIC_TYPES = ['NUMBER', 'DECIMAL', 'FORMULA']

/**
 * Verifica as fórmulas de um conjunto de campos: referências a campos numéricos que existam e não estejam
 * arquivados, sem dados sensíveis numa fórmula visível, e sem ciclos. Devolve os problemas por campo.
 */
export function checkFormulaSet(fields: readonly FieldSpec[]): { code: string; issue: Issue }[] {
  const problems: { code: string; issue: Issue }[] = []
  const byCode = new Map(fields.map((f) => [f.code, f]))
  const formulas = fields.filter((f) => f.type === 'FORMULA' && !f.archived)
  const report = (code: string, issueCode: string, message: string) =>
    problems.push({ code, issue: { path: 'validation.expression', code: issueCode, message } })

  for (const field of formulas) {
    for (const ref of (formulaOf(field) as StoredFormula).dependencies) {
      const target = byCode.get(ref)
      if (!target) {
        report(
          field.code,
          'FORMULA_UNKNOWN_FIELD',
          `A fórmula refere o campo desconhecido "${ref}".`
        )
      } else if (target.code === field.code) {
        report(field.code, 'CIRCULAR_FORMULA', 'Uma fórmula não pode referir-se a si própria.')
      } else if (target.archived) {
        report(field.code, 'FORMULA_ARCHIVED_FIELD', `A fórmula refere o campo arquivado "${ref}".`)
      } else if (!NUMERIC_TYPES.includes(target.type)) {
        report(
          field.code,
          'FORMULA_NOT_NUMERIC',
          `A fórmula só aceita campos numéricos; "${ref}" é do tipo ${target.type}.`
        )
      } else if (target.sensitive && !field.sensitive) {
        report(
          field.code,
          'FORMULA_LEAKS_SENSITIVE',
          `A fórmula usaria o campo sensível "${ref}" num resultado visível: marque também o resultado como sensível.`
        )
      }
    }
  }
  for (const code of orderFormulas(fields).cyclic) {
    report(code, 'CIRCULAR_FORMULA', 'As fórmulas referem-se umas às outras em círculo.')
  }
  return problems
}

export interface FormulaOrder {
  order: string[]
  cyclic: Set<string>
}

/** Ordem de cálculo (dependências primeiro) e fórmulas em ciclo (A → B → A, ou A → A). */
export function orderFormulas(fields: readonly FieldSpec[]): FormulaOrder {
  const deps = new Map<string, string[]>()
  for (const f of fields) {
    if (f.type === 'FORMULA' && !f.archived)
      deps.set(f.code, (formulaOf(f) as StoredFormula).dependencies)
  }
  const order: string[] = []
  const cyclic = new Set<string>()
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (code: string, stack: string[]) => {
    if (state.get(code) === 'done') return
    if (state.get(code) === 'visiting') {
      for (const member of stack.slice(stack.indexOf(code))) cyclic.add(member)
      return
    }
    state.set(code, 'visiting')
    for (const dep of deps.get(code) ?? []) if (deps.has(dep)) visit(dep, [...stack, code])
    state.set(code, 'done')
    order.push(code)
  }
  for (const code of deps.keys()) visit(code, [])
  return { order: order.filter((c) => !cyclic.has(c)), cyclic }
}

/** Calcula todas as fórmulas activas sobre os valores de um registo; as que dão vazio ficam `null`. */
export function computeFormulaValues(
  fields: readonly FieldSpec[],
  values: Readonly<Record<string, unknown>>
): Record<string, string | null> {
  const results: Record<string, string | null> = {}
  const byCode = new Map(fields.map((f) => [f.code, f]))
  const { order } = orderFormulas(fields)
  const valueOf = (code: string): bigint | null =>
    Object.hasOwn(results, code) ? scaledOf(results[code]) : scaledOf(values[code])
  for (const code of order) {
    const formula = formulaOf(byCode.get(code) as FieldSpec) as StoredFormula
    results[code] = evaluateFormula(formula.ast, valueOf, formula.scale)
  }
  return results
}
