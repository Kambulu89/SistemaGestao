import { isValidTimezone, parseCron, tooFrequent } from '#dynamic/automations/domain/cron'

/**
 * Automações (C15): reagem a **um** gatilho (evento do outbox ou calendário), avaliam uma condição declarativa e executam
 * acções registadas pelos módulos. Nada do que o tenant escreve é código: condições são AST das políticas de acesso e os
 * parâmetros das acções são valores literais ou referências a campos do evento (`{ "from": "payload.recordId" }`).
 */
export type AutomationStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED'
export type RunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD'

export type ParamValue = string | number | boolean | { from: string }
export interface ActionDef {
  type: string
  params: Record<string, ParamValue>
}

export interface AutomationIssue {
  path: string
  code: string
  message: string
}

export const AUTOMATION_CODE = /^[a-z][a-z0-9_]{1,49}$/
export const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/
export const ACTION_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/
export const MAX_ACTIONS = 10
export const MAX_PERIOD_RUNS = 10_000
export const DEFAULT_PERIOD_RUNS = 60

/** Profundidade máxima da cadeia evento → automação → evento… (um ciclo A→B→A pára aqui). */
export const MAX_DEPTH = 4
export const MAX_ATTEMPTS = 5
/** Duração máxima de uma execução, em milissegundos. */
export const RUN_TIMEOUT_MS = 30_000
export const PERIOD_MS = 3_600_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Referências que um parâmetro pode fazer: campos do evento ou o instante agendado. */
const REFERENCE = /^(payload\.[A-Za-z][A-Za-z0-9_]{0,59}|schedule\.at)$/

export interface NormalizedAutomation {
  eventType: string | null
  schedule: string | null
  timezone: string
  condition: unknown
  actions: ActionDef[]
  maxRunsPerPeriod: number
}

export interface AutomationInput {
  eventType?: unknown
  schedule?: unknown
  timezone?: unknown
  condition?: unknown
  actions?: unknown
  maxRunsPerPeriod?: unknown
}

export function normalizeActions(raw: unknown, issues: AutomationIssue[]): ActionDef[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ACTIONS) {
    issues.push({
      path: 'actions',
      code: 'INVALID_ACTIONS',
      message: `Indique 1 a ${MAX_ACTIONS} acções.`,
    })
    return []
  }
  const actions: ActionDef[] = []
  raw.forEach((item, i) => {
    const path = `actions[${i}]`
    if (!isRecord(item)) {
      issues.push({ path, code: 'INVALID_ACTION', message: 'Acção inválida.' })
      return
    }
    for (const key of Object.keys(item)) {
      if (!['type', 'params'].includes(key)) {
        issues.push({
          path: `${path}.${key}`,
          code: 'UNKNOWN_KEY',
          message: `«${key}» não existe.`,
        })
      }
    }
    if (typeof item.type !== 'string' || !ACTION_TYPE.test(item.type)) {
      issues.push({
        path: `${path}.type`,
        code: 'INVALID_ACTION_TYPE',
        message: 'Tipo de acção inválido.',
      })
      return
    }
    const params = item.params ?? {}
    if (!isRecord(params)) {
      issues.push({
        path: `${path}.params`,
        code: 'INVALID_PARAMS',
        message: 'Os parâmetros são um objecto.',
      })
      return
    }
    const clean: Record<string, ParamValue> = {}
    let ok = true
    for (const [name, value] of Object.entries(params)) {
      const at = `${path}.params.${name}`
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(name)) {
        issues.push({
          path: at,
          code: 'INVALID_PARAM_NAME',
          message: 'Nome de parâmetro inválido.',
        })
        ok = false
      } else if (typeof value === 'string' && value.length <= 500) clean[name] = value
      else if (typeof value === 'number' && Number.isFinite(value)) clean[name] = value
      else if (typeof value === 'boolean') clean[name] = value
      else if (
        isRecord(value) &&
        Object.keys(value).length === 1 &&
        typeof value.from === 'string' &&
        REFERENCE.test(value.from)
      ) {
        clean[name] = { from: value.from }
      } else {
        issues.push({
          path: at,
          code: 'INVALID_PARAM',
          message: 'Um parâmetro é um texto, número, booleano ou { "from": "payload.campo" }.',
        })
        ok = false
      }
    }
    if (ok) actions.push({ type: item.type, params: clean })
  })
  return actions
}

/** Valida o gatilho (exactamente um), o fuso, o limite e as acções; a condição e o catálogo validam-se na aplicação. */
export function normalizeAutomation(
  input: AutomationInput,
  defaults: { timezone: string },
  issues: AutomationIssue[]
): NormalizedAutomation {
  const before = issues.length
  const eventType = input.eventType ?? null
  const schedule = input.schedule ?? null
  if ((eventType === null) === (schedule === null)) {
    issues.push({
      path: 'trigger',
      code: 'TRIGGER_EXACTLY_ONE',
      message: 'Indique exactamente um gatilho: um tipo de evento ou um calendário.',
    })
  }
  if (eventType !== null && (typeof eventType !== 'string' || !EVENT_TYPE.test(eventType))) {
    issues.push({
      path: 'eventType',
      code: 'INVALID_EVENT_TYPE',
      message: 'Tipo de evento inválido.',
    })
  }
  const timezone = typeof input.timezone === 'string' ? input.timezone : defaults.timezone
  if (!isValidTimezone(timezone)) {
    issues.push({
      path: 'timezone',
      code: 'INVALID_TIMEZONE',
      message: 'Fuso horário desconhecido.',
    })
  }
  if (schedule !== null) {
    if (typeof schedule !== 'string' || schedule.length > 100) {
      issues.push({ path: 'schedule', code: 'INVALID_SCHEDULE', message: 'Calendário inválido.' })
    } else {
      const spec = parseCron(schedule)
      if (typeof spec === 'string') {
        issues.push({ path: 'schedule', code: 'INVALID_SCHEDULE', message: spec })
      } else if (isValidTimezone(timezone) && tooFrequent(spec, timezone)) {
        issues.push({
          path: 'schedule',
          code: 'SCHEDULE_TOO_FREQUENT',
          message: 'O intervalo mínimo entre execuções é de 5 minutos.',
        })
      }
    }
  }
  const maxRunsPerPeriod = input.maxRunsPerPeriod ?? DEFAULT_PERIOD_RUNS
  if (
    typeof maxRunsPerPeriod !== 'number' ||
    !Number.isInteger(maxRunsPerPeriod) ||
    maxRunsPerPeriod < 1 ||
    maxRunsPerPeriod > MAX_PERIOD_RUNS
  ) {
    issues.push({
      path: 'maxRunsPerPeriod',
      code: 'INVALID_LIMIT',
      message: `O limite por hora é um inteiro entre 1 e ${MAX_PERIOD_RUNS}.`,
    })
  }
  if (input.condition !== undefined && input.condition !== null && !isRecord(input.condition)) {
    issues.push({
      path: 'condition',
      code: 'INVALID_CONDITION',
      message: 'A condição é um objecto (AST).',
    })
  }
  const actions = normalizeActions(input.actions, issues)
  if (issues.length > before) {
    return {
      eventType: null,
      schedule: null,
      timezone,
      condition: null,
      actions: [],
      maxRunsPerPeriod: DEFAULT_PERIOD_RUNS,
    }
  }
  return {
    eventType: eventType as string | null,
    schedule: schedule as string | null,
    timezone,
    condition: input.condition ?? null,
    actions,
    maxRunsPerPeriod: maxRunsPerPeriod as number,
  }
}

export interface ParamContext {
  payload: Record<string, unknown>
  scheduledFor: Date | null
}

/** Resolve as referências de um parâmetro; uma referência em falta lança (a execução falha, nunca assume um valor). */
export function resolveParams(
  params: Record<string, ParamValue>,
  context: ParamContext
): Record<string, string | number | boolean> {
  const resolved: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'object') {
      resolved[name] = value
      continue
    }
    if (value.from === 'schedule.at') {
      if (!context.scheduledFor)
        throw new Error(
          `O parâmetro «${name}» pede o instante agendado, mas o gatilho é um evento.`
        )
      resolved[name] = context.scheduledFor.toISOString()
      continue
    }
    const key = value.from.slice('payload.'.length)
    const found = context.payload[key]
    if (typeof found !== 'string' && typeof found !== 'number' && typeof found !== 'boolean') {
      throw new Error(`O campo «${key}» não existe no evento ou não é um valor simples.`)
    }
    resolved[name] = found
  }
  return resolved
}

/** Referências usadas pelos parâmetros de uma acção (para as verificar contra o catálogo do evento). */
export function referencesOf(params: Record<string, ParamValue>): string[] {
  return Object.values(params).flatMap((v) => (typeof v === 'object' ? [v.from] : []))
}

// --- chaves de deduplicação, atrasos e limites ----------------------------------------------------------

/** Evento + automação + versão: o mesmo evento nunca produz duas execuções da mesma versão. */
export const eventDedupeKey = (eventId: string, automationId: string, version: number) =>
  `event:${eventId}:${automationId}:v${version}`

/** Instante agendado + automação. */
export const scheduleDedupeKey = (automationId: string, instant: Date) =>
  `sched:${automationId}:${instant.toISOString()}`

/** Atraso até à próxima tentativa: exponencial (30 s, 1 min, 2 min…, máx. 1 h) com variação ±20%. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 3_600_000)
  return Math.round(base * (0.8 + random() * 0.4))
}

/** Classificação do que acontece a uma execução falhada: nova tentativa ou fila de falhas. */
export function afterFailure(attempts: number): 'RETRY' | 'DEAD' {
  return attempts >= MAX_ATTEMPTS ? 'DEAD' : 'RETRY'
}

/** Códigos de erro que fecham a execução sem tentativa nem reprocessamento (regras do motor, não falhas de acção). */
export const GUARD_CODES = ['CAUSALITY_DEPTH', 'CAUSALITY_LOOP', 'PERIOD_LIMIT'] as const

/** Variáveis (`resource.x`, `subject.y`, `env.z`) usadas por uma condição. */
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

/**
 * Valida os parâmetros de texto de uma acção: os obrigatórios têm de existir, nenhum desconhecido, e cada um é um texto
 * literal ou uma referência (`{ "from": … }`). Ajuda dos módulos que registam acções.
 */
export function textParamIssues(
  params: Record<string, ParamValue>,
  required: readonly string[],
  optional: readonly string[] = []
): AutomationIssue[] {
  const issues: AutomationIssue[] = []
  for (const name of required) {
    if (params[name] === undefined) {
      issues.push({
        path: `params.${name}`,
        code: 'PARAM_REQUIRED',
        message: `O parâmetro «${name}» é obrigatório.`,
      })
    }
  }
  for (const [name, value] of Object.entries(params)) {
    if (![...required, ...optional].includes(name)) {
      issues.push({
        path: `params.${name}`,
        code: 'UNKNOWN_PARAM',
        message: `O parâmetro «${name}» não existe nesta acção.`,
      })
    } else if (typeof value !== 'string' && typeof value !== 'object') {
      issues.push({
        path: `params.${name}`,
        code: 'INVALID_PARAM',
        message: `O parâmetro «${name}» é um texto.`,
      })
    }
  }
  return issues
}
