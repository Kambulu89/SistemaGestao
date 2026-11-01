import { createHash } from 'node:crypto'

/**
 * Regras de negócio declarativas (C12). A condição é uma AST (a mesma gramática das políticas de acesso, avaliada
 * pelo módulo de permissões) e a acção é uma AST de bloqueio: nunca se executa código, SQL nem rede do tenant.
 *
 * Uma regra **bloqueia** a escrita quando a sua condição se verifica (ex.: «desconto > 20» → «desconto excede a
 * alçada»). Só se escreve a regra publicada em vigor; uma alteração faz-se numa nova revisão.
 */
export type RuleStatus = 'DRAFT' | 'PUBLISHED' | 'DISABLED'
export type RuleTrigger = 'VALIDATE'
export type EvaluationResult = 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR'

export interface BlockAction {
  type: 'BLOCK'
  message: string
  /** Campo ao qual a mensagem se associa (código); sem ele a mensagem é do registo. */
  field?: string
}

export interface RuleIssue {
  path: string
  code: string
  message: string
}

export const RULE_CODE = /^[a-z][a-z0-9_]{1,49}$/
export const MAX_MESSAGE = 240
export const MAX_PRIORITY = 1000
export const DEFAULT_PRIORITY = 100

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Valida a acção: só `BLOCK`, com mensagem de negócio e, opcionalmente, o campo a que se refere. */
export function normalizeAction(
  raw: unknown,
  issues: RuleIssue[],
  path = 'actionAst'
): BlockAction | null {
  const before = issues.length
  if (!isRecord(raw)) {
    issues.push({ path, code: 'INVALID_ACTION', message: 'A acção tem de ser um objecto.' })
    return null
  }
  for (const key of Object.keys(raw)) {
    if (!['type', 'message', 'field'].includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        code: 'UNKNOWN_ACTION_KEY',
        message: `"${key}" não existe.`,
      })
    }
  }
  if (raw.type !== 'BLOCK') {
    issues.push({
      path: `${path}.type`,
      code: 'UNSUPPORTED_ACTION',
      message: 'Só existe a acção BLOCK.',
    })
  }
  const message = typeof raw.message === 'string' ? raw.message.trim() : ''
  if (!message || message.length > MAX_MESSAGE) {
    issues.push({
      path: `${path}.message`,
      code: 'INVALID_MESSAGE',
      message: `A mensagem de negócio é obrigatória (máx. ${MAX_MESSAGE}).`,
    })
  }
  let field: string | undefined
  if (raw.field !== undefined && raw.field !== null) {
    if (typeof raw.field !== 'string' || !RULE_CODE.test(raw.field)) {
      issues.push({
        path: `${path}.field`,
        code: 'INVALID_FIELD',
        message: 'Código de campo inválido.',
      })
    } else field = raw.field
  }
  if (issues.length > before) return null
  return { type: 'BLOCK', message, ...(field ? { field } : {}) }
}

/** Variáveis usadas por uma condição (`resource.preco`, `subject.membershipId`…), pela ordem em que aparecem. */
export function conditionVariables(condition: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (isRecord(node)) {
      if (typeof node.var === 'string') found.push(node.var)
      for (const child of Object.values(node)) walk(child)
    }
  }
  walk(condition)
  return [...new Set(found)]
}

/** Variáveis de contexto permitidas além dos campos do registo. */
export const SUBJECT_VARIABLES = [
  'subject.membershipId',
  'subject.userId',
  'subject.organizationId',
]
export const ENV_VARIABLES = ['env.now']

/** Uma regra está em vigor num instante se este cai dentro do período (limites abertos = sem limite). */
export function isEffective(
  rule: { effectiveFrom: Date | null; effectiveTo: Date | null },
  now: Date
): boolean {
  if (rule.effectiveFrom && now < rule.effectiveFrom) return false
  if (rule.effectiveTo && now >= rule.effectiveTo) return false
  return true
}

/**
 * Resumo (SHA-256) dos dados avaliados: permite reconhecer a mesma entrada sem guardar valores, que podem ser
 * pessoais ou sensíveis. As chaves ordenam-se para o resumo não depender da ordem.
 */
export function inputHash(values: Record<string, unknown>): string {
  const sorted = Object.keys(values)
    .sort()
    .map((key) => [key, values[key]])
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}
