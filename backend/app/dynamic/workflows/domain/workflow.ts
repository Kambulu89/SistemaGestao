/**
 * Workflows de aprovação (C14). A definição é um conjunto ordenado de **etapas**; cada etapa abre tarefas em paralelo
 * (uma por responsável) e fecha segundo um critério ALL, ANY ou QUORUM. Uma etapa pode ter uma condição (AST das políticas
 * de acesso, avaliada sobre o registo congelado) que a dispensa, por exemplo abaixo de uma alçada. Tudo é declarativo:
 * nunca se executa código do tenant, e nenhum workflow escreve nos recursos — emite eventos que os módulos consomem.
 */
export type WorkflowStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED'
export const CRITERIA = ['ALL', 'ANY', 'QUORUM'] as const
export type Criteria = (typeof CRITERIA)[number]
export const APPROVER_TYPES = ['MEMBERSHIP', 'ROLE'] as const
export type ApproverType = (typeof APPROVER_TYPES)[number]

export interface ApproverDef {
  type: ApproverType
  id: string
}

export interface StageDef {
  code: string
  label: string
  /** Dispensa a etapa quando é falsa sobre os dados do registo congelado. */
  condition?: unknown
  approvers: ApproverDef[]
  criteria: Criteria
  /** Aprovações necessárias (só em QUORUM). */
  quorum?: number
  /** Prazo da tarefa, em horas, a contar da abertura da etapa. */
  dueInHours?: number
  /** `false` (por omissão): quem submeteu não decide a sua própria submissão. */
  allowSelfApproval: boolean
}

export interface WorkflowGraph {
  stages: StageDef[]
  /** Campo do registo (decimal) que dá o montante em causa: limita as delegações e aparece na caixa de aprovações. */
  amountField?: string
  /** Campo do registo (texto de 3 letras) com a moeda do montante. */
  currencyField?: string
}

export interface WorkflowIssue {
  path: string
  code: string
  message: string
}

export const WORKFLOW_CODE = /^[a-z][a-z0-9_]{1,49}$/
const STAGE_CODE = /^[a-z][a-z0-9_]{1,49}$/
const FIELD_CODE = /^[a-z][a-z0-9_]{0,49}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_STAGES = 20
export const MAX_APPROVERS = 20
export const MAX_DUE_HOURS = 24 * 365

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownKeys(
  raw: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: WorkflowIssue[]
) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${path}.${key}`, code: 'UNKNOWN_KEY', message: `«${key}» não existe.` })
    }
  }
}

function normalizeApprovers(raw: unknown, path: string, issues: WorkflowIssue[]): ApproverDef[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_APPROVERS) {
    issues.push({
      path,
      code: 'INVALID_APPROVERS',
      message: `Indique 1 a ${MAX_APPROVERS} responsáveis.`,
    })
    return []
  }
  const approvers: ApproverDef[] = []
  const seen = new Set<string>()
  raw.forEach((item, i) => {
    const at = `${path}[${i}]`
    if (!isRecord(item)) {
      issues.push({ path: at, code: 'INVALID_APPROVER', message: 'Responsável inválido.' })
      return
    }
    unknownKeys(item, ['type', 'id'], at, issues)
    if (!(APPROVER_TYPES as readonly unknown[]).includes(item.type)) {
      issues.push({
        path: `${at}.type`,
        code: 'INVALID_APPROVER_TYPE',
        message: `Tipo: ${APPROVER_TYPES.join(' ou ')}.`,
      })
      return
    }
    if (typeof item.id !== 'string' || !UUID.test(item.id)) {
      issues.push({
        path: `${at}.id`,
        code: 'INVALID_APPROVER_ID',
        message: 'Identificador inválido.',
      })
      return
    }
    const key = `${item.type}:${item.id.toLowerCase()}`
    if (seen.has(key)) {
      issues.push({
        path: at,
        code: 'DUPLICATE_APPROVER',
        message: 'Responsável repetido na etapa.',
      })
      return
    }
    seen.add(key)
    approvers.push({ type: item.type as ApproverType, id: item.id.toLowerCase() })
  })
  return approvers
}

export function normalizeGraph(raw: unknown, issues: WorkflowIssue[]): WorkflowGraph {
  const empty: WorkflowGraph = { stages: [] }
  if (!isRecord(raw)) {
    issues.push({
      path: 'graph',
      code: 'INVALID_GRAPH',
      message: 'O grafo é um objecto com etapas.',
    })
    return empty
  }
  unknownKeys(raw, ['stages', 'amountField', 'currencyField'], 'graph', issues)
  if (!Array.isArray(raw.stages) || raw.stages.length === 0 || raw.stages.length > MAX_STAGES) {
    issues.push({
      path: 'graph.stages',
      code: 'INVALID_STAGES',
      message: `Indique 1 a ${MAX_STAGES} etapas.`,
    })
    return empty
  }
  const stages: StageDef[] = []
  const seen = new Set<string>()
  raw.stages.forEach((item, i) => {
    const path = `graph.stages[${i}]`
    if (!isRecord(item)) {
      issues.push({ path, code: 'INVALID_STAGE', message: 'Etapa inválida.' })
      return
    }
    const before = issues.length
    unknownKeys(
      item,
      [
        'code',
        'label',
        'condition',
        'approvers',
        'criteria',
        'quorum',
        'dueInHours',
        'allowSelfApproval',
      ],
      path,
      issues
    )
    if (typeof item.code !== 'string' || !STAGE_CODE.test(item.code)) {
      issues.push({
        path: `${path}.code`,
        code: 'INVALID_CODE',
        message: 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).',
      })
    } else if (seen.has(item.code)) {
      issues.push({
        path: `${path}.code`,
        code: 'DUPLICATE_STAGE',
        message: 'Código de etapa repetido.',
      })
    } else seen.add(item.code)
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120) {
      issues.push({
        path: `${path}.label`,
        code: 'INVALID_LABEL',
        message: 'O rótulo é obrigatório (máx. 120).',
      })
    }
    if (!(CRITERIA as readonly unknown[]).includes(item.criteria)) {
      issues.push({
        path: `${path}.criteria`,
        code: 'INVALID_CRITERIA',
        message: `Critério: ${CRITERIA.join(', ')}.`,
      })
    }
    const approvers = normalizeApprovers(item.approvers, `${path}.approvers`, issues)
    if (item.criteria === 'QUORUM') {
      if (
        typeof item.quorum !== 'number' ||
        !Number.isInteger(item.quorum) ||
        item.quorum < 1 ||
        item.quorum > approvers.length
      ) {
        issues.push({
          path: `${path}.quorum`,
          code: 'INVALID_QUORUM',
          message: 'O quórum é um inteiro entre 1 e o número de responsáveis.',
        })
      }
    } else if (item.quorum !== undefined) {
      issues.push({
        path: `${path}.quorum`,
        code: 'QUORUM_NOT_ALLOWED',
        message: 'O quórum só se indica no critério QUORUM.',
      })
    }
    if (
      item.dueInHours !== undefined &&
      (typeof item.dueInHours !== 'number' ||
        !Number.isInteger(item.dueInHours) ||
        item.dueInHours < 1 ||
        item.dueInHours > MAX_DUE_HOURS)
    ) {
      issues.push({
        path: `${path}.dueInHours`,
        code: 'INVALID_DUE',
        message: `O prazo é um número inteiro de horas (1 a ${MAX_DUE_HOURS}).`,
      })
    }
    if (item.allowSelfApproval !== undefined && typeof item.allowSelfApproval !== 'boolean') {
      issues.push({
        path: `${path}.allowSelfApproval`,
        code: 'INVALID_FLAG',
        message: 'allowSelfApproval é booleano.',
      })
    }
    if (item.condition !== undefined && !isRecord(item.condition)) {
      issues.push({
        path: `${path}.condition`,
        code: 'INVALID_CONDITION',
        message: 'A condição é um objecto (AST).',
      })
    }
    if (issues.length > before) return
    stages.push({
      code: item.code as string,
      label: (item.label as string).trim(),
      ...(item.condition !== undefined ? { condition: item.condition } : {}),
      approvers,
      criteria: item.criteria as Criteria,
      ...(item.criteria === 'QUORUM' ? { quorum: item.quorum as number } : {}),
      ...(typeof item.dueInHours === 'number' ? { dueInHours: item.dueInHours } : {}),
      allowSelfApproval: item.allowSelfApproval === true,
    })
  })
  for (const key of ['amountField', 'currencyField'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !FIELD_CODE.test(raw[key]))) {
      issues.push({
        path: `graph.${key}`,
        code: 'INVALID_FIELD',
        message: 'Código de campo inválido.',
      })
    }
  }
  if (raw.currencyField !== undefined && raw.amountField === undefined) {
    issues.push({
      path: 'graph.currencyField',
      code: 'CURRENCY_WITHOUT_AMOUNT',
      message: 'A moeda só faz sentido com um campo de montante.',
    })
  }
  return {
    stages,
    ...(typeof raw.amountField === 'string' ? { amountField: raw.amountField } : {}),
    ...(typeof raw.currencyField === 'string' ? { currencyField: raw.currencyField } : {}),
  }
}

/** Variáveis (`resource.x`, `subject.y`) usadas por uma condição. */
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

export const SUBJECT_VARIABLES = [
  'subject.membershipId',
  'subject.userId',
  'subject.organizationId',
]
export const ENV_VARIABLES = ['env.now']

// --- decisão de uma etapa -----------------------------------------------------------------------

export type TaskStatus = 'OPEN' | 'CLAIMED' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED'
export type StageOutcome = 'APPROVED' | 'REJECTED' | 'PENDING'

/**
 * Resultado de uma etapa a partir do estado das suas tarefas:
 *  - ALL: todas aprovam; uma rejeição rejeita.
 *  - ANY: uma aprovação basta; só rejeita quando já ninguém pode aprovar.
 *  - QUORUM: `quorum` aprovações; rejeita quando já não é possível atingi-lo.
 * Nunca aprova por omissão: sem tarefas, a etapa fica pendente.
 */
export function stageOutcome(
  criteria: Criteria,
  quorum: number | undefined,
  statuses: readonly TaskStatus[]
): StageOutcome {
  if (statuses.length === 0) return 'PENDING'
  const approved = statuses.filter((s) => s === 'APPROVED').length
  const rejected = statuses.filter((s) => s === 'REJECTED').length
  const waiting = statuses.filter((s) => s === 'OPEN' || s === 'CLAIMED').length
  if (criteria === 'ALL') {
    if (rejected > 0) return 'REJECTED'
    return approved === statuses.length ? 'APPROVED' : 'PENDING'
  }
  if (criteria === 'ANY') {
    if (approved > 0) return 'APPROVED'
    return waiting === 0 ? 'REJECTED' : 'PENDING'
  }
  const needed = quorum ?? statuses.length
  if (approved >= needed) return 'APPROVED'
  return approved + waiting < needed ? 'REJECTED' : 'PENDING'
}

// --- montantes (decimais exactos, nunca float) ----------------------------------------------------

const DECIMAL = /^-?\d+(\.\d+)?$/

/** Compara dois decimais em texto; `null` se algum não for um decimal. */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 | null {
  if (!DECIMAL.test(a) || !DECIMAL.test(b)) return null
  const parse = (value: string) => {
    const negative = value.startsWith('-')
    const [int = '0', frac = ''] = (negative ? value.slice(1) : value).split('.')
    return { negative, int: int.replace(/^0+(?=\d)/, ''), frac: frac.replace(/0+$/, '') }
  }
  const x = parse(a)
  const y = parse(b)
  const zero = (v: ReturnType<typeof parse>) => v.int === '0' && v.frac === ''
  if (zero(x) && zero(y)) return 0
  if (x.negative !== y.negative) return x.negative ? -1 : 1
  const sign = x.negative ? -1 : 1
  let cmp: number
  if (x.int.length !== y.int.length) cmp = x.int.length < y.int.length ? -1 : 1
  else if (x.int !== y.int) cmp = x.int < y.int ? -1 : 1
  else {
    const size = Math.max(x.frac.length, y.frac.length)
    const fx = x.frac.padEnd(size, '0')
    const fy = y.frac.padEnd(size, '0')
    cmp = fx === fy ? 0 : fx < fy ? -1 : 1
  }
  return (cmp * sign) as -1 | 0 | 1
}

// --- delegações -------------------------------------------------------------------------------------

export interface DelegationScope {
  /** Códigos dos workflows abrangidos; vazio/ausente = todos. */
  workflowCodes?: string[]
}

export function normalizeScope(raw: unknown, issues: WorkflowIssue[]): DelegationScope {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) {
    issues.push({ path: 'scope', code: 'INVALID_SCOPE', message: 'O âmbito é um objecto.' })
    return {}
  }
  unknownKeys(raw, ['workflowCodes'], 'scope', issues)
  const codes = raw.workflowCodes
  if (codes === undefined) return {}
  if (
    !Array.isArray(codes) ||
    codes.length > 50 ||
    !codes.every((c) => typeof c === 'string' && WORKFLOW_CODE.test(c)) ||
    new Set(codes).size !== codes.length
  ) {
    issues.push({
      path: 'scope.workflowCodes',
      code: 'INVALID_SCOPE',
      message: 'Indique códigos de workflow válidos, sem repetir.',
    })
    return {}
  }
  return codes.length > 0 ? { workflowCodes: codes as string[] } : {}
}

export interface DelegationEdge {
  from: string
  to: string
}

/**
 * `true` se acrescentar `from → to` fechava um ciclo (A→B e B→A, ou mais longo). Uma delegação a si próprio também o é.
 */
export function createsCycle(existing: readonly DelegationEdge[], edge: DelegationEdge): boolean {
  if (edge.from === edge.to) return true
  const next = new Map<string, string[]>()
  for (const e of existing) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const seen = new Set<string>()
  const stack = [edge.to]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (current === edge.from) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(next.get(current) ?? []))
  }
  return false
}
