import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  AUTOMATION_CODE,
  ENV_VARIABLES,
  SUBJECT_VARIABLES,
  conditionVariables,
  normalizeAutomation,
  referencesOf,
  resolveParams,
  type AutomationInput,
  type AutomationIssue,
} from '#dynamic/automations/domain/automation'
import { nextFire, parseCron } from '#dynamic/automations/domain/cron'
import type {
  Automation,
  AutomationCatalog,
  AutomationStore,
  ConditionEngine,
} from '#dynamic/automations/application/ports'
import { currentCatalog, findAction, findEvent } from '#dynamic/automations/application/registry'
import { memberOf } from '#dynamic/automations/application/actor'

export const automationValidation = (details: AutomationIssue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export interface AutomationView extends Automation {
  /** O que o servidor verifica agora (vazio = pode activar-se). */
  issues: AutomationIssue[]
}

export interface Simulation {
  /** `null` se a automação não tem condição. */
  conditionPassed: boolean | null
  conditionError: string | null
  actions: {
    type: string
    params: Record<string, string | number | boolean> | null
    error: string | null
  }[]
  /** Só gatilhos por calendário: as próximas execuções (no fuso da automação). */
  nextRuns: string[]
}

/**
 * Definição, activação e simulação de automações (C15). Guardar exige só que esteja bem formada; activar verifica o
 * gatilho, a condição e as acções contra o catálogo que os módulos registaram, e fixa o **membro em nome de quem executa**
 * (quem activa). Pausar bloqueia novas execuções sem apagar o histórico.
 */
export class AutomationUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly automations: AutomationStore,
    private readonly engine: ConditionEngine,
    private readonly tenantTimezone: (tenantId: string) => Promise<string>,
    private readonly clock: () => Date = () => new Date()
  ) {}

  catalog(): AutomationCatalog {
    return currentCatalog()
  }

  async list(context: TenantContext): Promise<AutomationView[]> {
    const rows = await this.uow.run((scope) => this.automations.list(scope), context)
    return rows.map((a) => ({ ...a, issues: a.status === 'DRAFT' ? [] : this.integrity(a) }))
  }

  async get(context: TenantContext, id: string): Promise<AutomationView> {
    const row = await this.uow.run((scope) => this.mustFind(scope, id), context)
    return { ...row, issues: this.integrity(row) }
  }

  async create(
    context: TenantContext,
    input: AutomationInput & { code: string; name: string; description?: string | null }
  ): Promise<Automation> {
    const values = await this.values(context, input, null)
    return this.uow.run(async (scope) => {
      const created = await this.automations.insert(scope, values)
      if (!created) {
        throw ApiError.conflict('AUTOMATION_CODE_TAKEN', 'Já existe uma automação com este código.')
      }
      return created
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    input: AutomationInput & { name?: string; description?: string | null; expectedVersion: number }
  ): Promise<Automation> {
    const current = await this.uow.run((scope) => this.mustFind(scope, id), context)
    if (current.status === 'ACTIVE') {
      throw ApiError.conflict(
        'AUTOMATION_ACTIVE',
        'Pause a automação antes de a alterar: uma automação activa não muda.'
      )
    }
    const values = await this.values(context, { ...this.asInput(current), ...input }, current)
    return this.uow.run(
      (scope) =>
        this.automations.update(scope, id, input.expectedVersion, {
          name: values.name,
          description: values.description,
          eventType: values.eventType,
          schedule: values.schedule,
          timezone: values.timezone,
          condition: values.condition,
          actions: values.actions,
          maxRunsPerPeriod: values.maxRunsPerPeriod,
        }),
      context
    )
  }

  async activate(context: TenantContext, id: string, expectedVersion: number): Promise<Automation> {
    const me = memberOf(context)
    const current = await this.uow.run((scope) => this.mustFind(scope, id), context)
    if (current.status === 'ACTIVE') {
      throw ApiError.conflict('AUTOMATION_ACTIVE', 'A automação já está activa.')
    }
    const issues = this.integrity(current)
    if (issues.length > 0) throw automationValidation(issues)
    const nextRunAt = current.schedule ? this.next(current.schedule, current.timezone) : null
    return this.uow.run(
      (scope) => this.automations.activate(scope, id, expectedVersion, me, nextRunAt),
      context
    )
  }

  pause(context: TenantContext, id: string, expectedVersion: number): Promise<Automation> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      if (current.status !== 'ACTIVE') {
        throw ApiError.conflict('AUTOMATION_NOT_ACTIVE', 'Só uma automação activa se pausa.')
      }
      return this.automations.pause(scope, id, expectedVersion)
    }, context)
  }

  /** Avalia a condição e resolve as acções para um evento de exemplo, sem executar nada. */
  async simulate(
    context: TenantContext,
    id: string,
    sample: { payload?: Record<string, unknown>; scheduledFor?: Date | null }
  ): Promise<Simulation> {
    const automation = await this.uow.run((scope) => this.mustFind(scope, id), context)
    const payload = sample.payload ?? {}
    let conditionPassed: boolean | null = null
    let conditionError: string | null = null
    if (automation.condition) {
      try {
        conditionPassed = this.engine.evaluate(automation.condition, {
          subject: {
            membershipId: context.membershipId,
            userId: context.userId,
            organizationId: context.organizationId,
          },
          resource: payload,
          env: { now: this.clock().toISOString() },
        })
      } catch (error) {
        conditionError = error instanceof Error ? error.message : 'Condição inválida.'
      }
    }
    const actions = automation.actions.map((action) => {
      try {
        return {
          type: action.type,
          params: resolveParams(action.params, {
            payload,
            scheduledFor: sample.scheduledFor ?? null,
          }),
          error: null,
        }
      } catch (error) {
        return {
          type: action.type,
          params: null,
          error: error instanceof Error ? error.message : 'Parâmetros inválidos.',
        }
      }
    })
    const nextRuns: string[] = []
    if (automation.schedule) {
      let from = this.clock()
      for (let i = 0; i < 5; i++) {
        const next = this.next(automation.schedule, automation.timezone, from)
        if (!next) break
        nextRuns.push(next.toISOString())
        from = next
      }
    }
    return { conditionPassed, conditionError, actions, nextRuns }
  }

  // --- internos ------------------------------------------------------------------------------

  private asInput(a: Automation): AutomationInput {
    return {
      eventType: a.eventType,
      schedule: a.schedule,
      timezone: a.timezone,
      condition: a.condition,
      actions: a.actions,
      maxRunsPerPeriod: a.maxRunsPerPeriod,
    }
  }

  private async mustFind(scope: TenantScope, id: string): Promise<Automation> {
    const row = await this.automations.find(scope, id)
    if (!row) throw ApiError.notFound()
    return row
  }

  private next(schedule: string, timezone: string, from: Date = this.clock()): Date | null {
    const spec = parseCron(schedule)
    return typeof spec === 'string' ? null : nextFire(spec, timezone, from)
  }

  private async values(
    context: TenantContext,
    input: AutomationInput & { code?: string; name?: string; description?: string | null },
    base: Automation | null
  ) {
    const issues: AutomationIssue[] = []
    const code = (base?.code ?? input.code ?? '').trim()
    if (!AUTOMATION_CODE.test(code)) {
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).',
      })
    }
    const name = (input.name ?? base?.name ?? '').trim()
    if (!name || name.length > 160) {
      issues.push({
        path: 'name',
        code: 'INVALID_NAME',
        message: 'O nome é obrigatório (máx. 160).',
      })
    }
    const description =
      input.description === undefined
        ? (base?.description ?? null)
        : input.description?.toString().trim() || null
    if (description && description.length > 500) {
      issues.push({
        path: 'description',
        code: 'INVALID_DESCRIPTION',
        message: 'Máx. 500 caracteres.',
      })
    }
    const normalized = normalizeAutomation(
      input,
      { timezone: await this.tenantTimezone(context.tenantId) },
      issues
    )
    if (issues.length > 0) throw automationValidation(issues)
    return { code, name, description, ...normalized }
  }

  /** Gatilho, condição e acções contra o catálogo dos módulos. */
  private integrity(a: Automation): AutomationIssue[] {
    const issues: AutomationIssue[] = []
    const event = a.eventType ? findEvent(a.eventType) : undefined
    if (a.eventType && !event) {
      issues.push({
        path: 'eventType',
        code: 'UNKNOWN_EVENT_TYPE',
        message: `O evento «${a.eventType}» não existe no catálogo.`,
      })
    }
    const payloadFields = new Set(event?.fields.map((f) => f.name) ?? [])
    if (a.condition) {
      for (const problem of this.engine.validate(a.condition)) {
        issues.push({ ...problem, path: `condition${problem.path.replace(/^\$/, '')}` })
      }
      for (const variable of conditionVariables(a.condition)) {
        if (SUBJECT_VARIABLES.includes(variable) || ENV_VARIABLES.includes(variable)) continue
        const field = variable.startsWith('resource.') ? variable.slice('resource.'.length) : null
        if (field === null || !a.eventType || !payloadFields.has(field)) {
          issues.push({
            path: 'condition',
            code: 'UNKNOWN_FIELD',
            message: `«${variable}» não existe no evento (a condição lê os campos do evento como resource.<campo>).`,
          })
        }
      }
    }
    a.actions.forEach((action, i) => {
      const path = `actions[${i}]`
      const handler = findAction(action.type)
      if (!handler) {
        issues.push({
          path: `${path}.type`,
          code: 'UNKNOWN_ACTION',
          message: `A acção «${action.type}» não está disponível.`,
        })
        return
      }
      for (const problem of handler.validate(action.params)) {
        issues.push({ ...problem, path: `${path}.${problem.path}` })
      }
      for (const ref of referencesOf(action.params)) {
        const scheduled = ref === 'schedule.at'
        if (
          scheduled !== (a.schedule !== null) ||
          (!scheduled && !payloadFields.has(ref.slice('payload.'.length)))
        ) {
          issues.push({
            path: `${path}.params`,
            code: 'UNKNOWN_REFERENCE',
            message: `A referência «${ref}» não existe neste gatilho.`,
          })
        }
      }
    })
    return issues
  }
}
