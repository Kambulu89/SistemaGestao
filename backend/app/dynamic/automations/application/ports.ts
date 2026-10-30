import type { StoredOutboxEvent } from '#core/outbox/index'
import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  ActionDef,
  AutomationIssue,
  AutomationStatus,
  ParamValue,
  RunStatus,
} from '#dynamic/automations/domain/automation'

export interface Automation {
  id: string
  code: string
  name: string
  description: string | null
  eventType: string | null
  schedule: string | null
  timezone: string
  condition: unknown
  actions: ActionDef[]
  status: AutomationStatus
  maxRunsPerPeriod: number
  runAsMembershipId: string | null
  activatedAt: Date | null
  nextRunAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface AutomationValues {
  code: string
  name: string
  description: string | null
  eventType: string | null
  schedule: string | null
  timezone: string
  condition: unknown
  actions: ActionDef[]
  maxRunsPerPeriod: number
}

export interface AutomationStore {
  list(scope: TenantScope): Promise<Automation[]>
  find(scope: TenantScope, id: string): Promise<Automation | null>
  /** `null` se o código já existir no tenant. */
  insert(scope: TenantScope, values: AutomationValues): Promise<Automation | null>
  /** Só rascunhos e pausadas; incrementa a versão (as execuções ficam ligadas à versão que as originou). */
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<AutomationValues, 'code'>>
  ): Promise<Automation>
  activate(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    runAsMembershipId: string,
    nextRunAt: Date | null
  ): Promise<Automation>
  pause(scope: TenantScope, id: string, expectedVersion: number): Promise<Automation>
  /** Activas com este tipo de evento. */
  activeForEvent(scope: TenantScope, eventType: string): Promise<Automation[]>
  /** Activas com calendário cuja próxima execução já chegou (bloqueadas até ao fim da transacção). */
  dueScheduled(scope: TenantScope, now: Date): Promise<Automation[]>
  setNextRun(scope: TenantScope, id: string, nextRunAt: Date | null): Promise<void>
}

export interface AutomationRun {
  id: string
  automationId: string
  automationCode: string
  automationVersion: number
  triggerEventId: string | null
  scheduledFor: Date | null
  dedupeKey: string
  status: RunStatus
  attempts: number
  nextAttemptAt: Date
  causationId: string | null
  depth: number
  progress: number
  payload: Record<string, unknown>
  error: string | null
  errorCode: string | null
  startedAt: Date | null
  finishedAt: Date | null
  retriedByMembershipId: string | null
  retriedAt: Date | null
  createdAt: Date
  version: number
}

export interface NewRun {
  automationId: string
  automationVersion: number
  triggerEventId: string | null
  scheduledFor: Date | null
  dedupeKey: string
  status: 'PENDING' | 'DEAD'
  causationId: string | null
  depth: number
  payload: Record<string, unknown>
  error: string | null
  errorCode: string | null
}

export interface RunStore {
  /** `null` se a chave de deduplicação já existir (o evento ou o instante já foi tratado). */
  insertIfAbsent(scope: TenantScope, values: NewRun): Promise<AutomationRun | null>
  find(scope: TenantScope, id: string): Promise<AutomationRun | null>
  list(
    scope: TenantScope,
    filter: { automationId?: string; status?: RunStatus }
  ): Promise<AutomationRun[]>
  /** Execuções devidas: passam a RUNNING com mais uma tentativa; outros trabalhadores saltam as bloqueadas. */
  claimDue(scope: TenantScope, now: Date, limit: number): Promise<AutomationRun[]>
  setProgress(scope: TenantScope, runId: string, progress: number): Promise<void>
  succeed(scope: TenantScope, runId: string): Promise<void>
  fail(
    scope: TenantScope,
    runId: string,
    outcome: {
      status: 'PENDING' | 'DEAD'
      nextAttemptAt: Date
      error: string
      errorCode: string
    }
  ): Promise<void>
  /** DEAD/FAILED → PENDING com as tentativas a zero; regista quem reprocessou. */
  requeue(scope: TenantScope, runId: string, expectedVersion: number): Promise<AutomationRun>
  /** Execuções criadas desde `since` que contam para o limite por hora. */
  countSince(scope: TenantScope, automationId: string, since: Date): Promise<number>
  /** A automação de uma execução (para detectar que um evento foi causado pela própria automação). */
  automationOf(scope: TenantScope, runId: string): Promise<string | null>
}

export interface ActionParamSpec {
  name: string
  kind: 'text' | 'number' | 'boolean'
  required: boolean
  description: string
}

export interface ActionExecution {
  /** Contexto de quem a automação representa (`run_as`); nunca um superutilizador. */
  context: TenantContext
  params: Record<string, string | number | boolean>
  /** Estável por execução e acção: o destino pode usá-la para não repetir o efeito. */
  idempotencyKey: string
}

/** Acção que um módulo disponibiliza às automações (ex.: executar uma transição, submeter a aprovação). */
export interface ActionHandler {
  type: string
  label: string
  description: string
  params: ActionParamSpec[]
  /** Validação estática dos parâmetros (literais e referências), sem executar nada. */
  validate(params: Record<string, ParamValue>): AutomationIssue[]
  execute(input: ActionExecution): Promise<void>
}

export interface EventFieldSpec {
  name: string
  kind: 'text' | 'number' | 'boolean'
}

/** Tipo de evento do outbox que as automações podem usar como gatilho, com os campos do `payload`. */
export interface EventDescriptor {
  type: string
  label: string
  fields: EventFieldSpec[]
}

export interface AutomationCatalog {
  events: EventDescriptor[]
  actions: Pick<ActionHandler, 'type' | 'label' | 'description' | 'params'>[]
}

export interface ConditionEngine {
  validate(condition: unknown): AutomationIssue[]
  evaluate(
    condition: unknown,
    context: {
      subject: Record<string, unknown>
      resource: Record<string, unknown>
      env: Record<string, unknown>
    }
  ): boolean
}

export interface PermissionCatalog {
  has(code: string): boolean
}

/** O contexto de quem a automação representa, resolvido com as permissões e o estado actuais do tenant e do membro. */
export interface RunAsResolver {
  /** Lança se o membro já não está activo ou o tenant não está operacional. */
  resolve(tenantId: string, membershipId: string, correlationId: string): Promise<TenantContext>
  /** Tenants onde os trabalhadores podem executar (os operacionais). */
  operationalTenants(): Promise<string[]>
}

export type { StoredOutboxEvent }
