import { randomUUID } from 'node:crypto'
import { runWithCausation, type OutboxReader, type StoredOutboxEvent } from '#core/outbox/index'
import {
  serviceTenantContext,
  type TenantContext,
  type TenantScope,
  type TenantUnitOfWork,
} from '#core/tenancy/index'
import {
  MAX_DEPTH,
  PERIOD_MS,
  RUN_TIMEOUT_MS,
  afterFailure,
  backoffMs,
  eventDedupeKey,
  resolveParams,
  scheduleDedupeKey,
} from '#dynamic/automations/domain/automation'
import { nextFire, parseCron } from '#dynamic/automations/domain/cron'
import type {
  Automation,
  AutomationRun,
  AutomationStore,
  ConditionEngine,
  NewRun,
  RunAsResolver,
  RunStore,
} from '#dynamic/automations/application/ports'
import { findAction } from '#dynamic/automations/application/registry'

export const CONSUMER = 'automations'
const EVENT_BATCH = 50
const MAX_EVENT_BATCHES = 20
const RUN_BATCH = 10

class TimeoutError extends Error {
  constructor() {
    super('A execução excedeu a duração máxima.')
    this.name = 'TimeoutError'
  }
}

/** Corre `work` com um prazo; a acção não é interrompida (não há como), mas a execução fica falhada e é repetida. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), Math.max(ms, 1))
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

export interface TickResult {
  dispatched: number
  scheduled: number
  executed: number
}

/**
 * O motor das automações (C15), por tenant: **despacha** os eventos novos do outbox (inbox: cada evento uma só vez) e os
 * calendários vencidos para execuções com chave de deduplicação, e **executa** as execuções devidas em nome do membro que
 * activou a automação, com as suas permissões actuais. Limites: profundidade da cadeia, execuções por hora e duração;
 * falhas repetem com recuo e jitter até à fila de falhas (DEAD), de onde só um reprocessamento manual as devolve.
 */
export class AutomationEngine {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly automations: AutomationStore,
    private readonly runs: RunStore,
    private readonly reader: OutboxReader,
    private readonly conditions: ConditionEngine,
    private readonly runAs: RunAsResolver,
    private readonly clock: () => Date = () => new Date(),
    private readonly random: () => number = Math.random
  ) {}

  /** Uma volta completa para um tenant. Um tenant não operacional nunca chega aqui (ver `AutomationWorker`). */
  async processTenant(tenantId: string): Promise<TickResult> {
    const context = serviceTenantContext(tenantId, `automation-${randomUUID()}`)
    const dispatched = await this.dispatchEvents(context)
    const scheduled = await this.dispatchSchedules(context)
    const executed = await this.executeDue(context)
    return { dispatched, scheduled, executed }
  }

  // --- despacho ------------------------------------------------------------------------------

  async dispatchEvents(context: TenantContext): Promise<number> {
    let total = 0
    for (let i = 0; i < MAX_EVENT_BATCHES; i++) {
      const handled = await this.uow.run(async (scope) => {
        const events = await this.reader.undelivered(scope, CONSUMER, EVENT_BATCH)
        for (const event of events) {
          const matching = await this.automations.activeForEvent(scope, event.eventType)
          for (const automation of matching) {
            // Uma automação só reage aos eventos posteriores à sua activação.
            if (automation.activatedAt && event.createdAt < automation.activatedAt) continue
            await this.scheduleForEvent(scope, automation, event)
          }
          await this.reader.markDelivered(scope, CONSUMER, event.id)
        }
        return events.length
      }, context)
      total += handled
      if (handled < EVENT_BATCH) break
    }
    return total
  }

  private async scheduleForEvent(scope: TenantScope, a: Automation, event: StoredOutboxEvent) {
    const depth = event.causationDepth + 1
    const base: NewRun = {
      automationId: a.id,
      automationVersion: a.version,
      triggerEventId: event.id,
      scheduledFor: null,
      dedupeKey: eventDedupeKey(event.id, a.id, a.version),
      status: 'PENDING',
      causationId: event.causationRunId,
      depth,
      payload: event.payload,
      error: null,
      errorCode: null,
    }
    const dead = (errorCode: string, error: string): NewRun => ({
      ...base,
      status: 'DEAD',
      errorCode,
      error,
    })

    if (a.condition) {
      try {
        const passes = this.conditions.evaluate(a.condition, {
          subject: {},
          resource: event.payload,
          env: { now: this.clock().toISOString() },
        })
        if (!passes) return
      } catch (error) {
        // Falha fechada: uma condição que não se avalia não deixa a acção correr.
        await this.runs.insertIfAbsent(
          scope,
          dead('CONDITION_ERROR', error instanceof Error ? error.message : 'Condição inválida.')
        )
        return
      }
    }
    if (depth > MAX_DEPTH) {
      await this.runs.insertIfAbsent(
        scope,
        dead('CAUSALITY_DEPTH', `A cadeia de causalidade excede ${MAX_DEPTH} níveis.`)
      )
      return
    }
    // Uma automação nunca reage a um evento que ela própria causou.
    if (
      event.causationRunId &&
      (await this.runs.automationOf(scope, event.causationRunId)) === a.id
    ) {
      await this.runs.insertIfAbsent(
        scope,
        dead('CAUSALITY_LOOP', 'O evento foi causado por esta mesma automação.')
      )
      return
    }
    await this.insertLimited(scope, a, base)
  }

  private async insertLimited(scope: TenantScope, a: Automation, run: NewRun) {
    const since = new Date(this.clock().getTime() - PERIOD_MS)
    if ((await this.runs.countSince(scope, a.id, since)) >= a.maxRunsPerPeriod) {
      await this.runs.insertIfAbsent(scope, {
        ...run,
        status: 'DEAD',
        errorCode: 'PERIOD_LIMIT',
        error: `Limite de ${a.maxRunsPerPeriod} execuções por hora atingido.`,
      })
      return
    }
    await this.runs.insertIfAbsent(scope, run)
  }

  async dispatchSchedules(context: TenantContext): Promise<number> {
    const now = this.clock()
    return this.uow.run(async (scope) => {
      const due = await this.automations.dueScheduled(scope, now)
      for (const a of due) {
        const instant = a.nextRunAt as Date
        await this.insertLimited(scope, a, {
          automationId: a.id,
          automationVersion: a.version,
          triggerEventId: null,
          scheduledFor: instant,
          dedupeKey: scheduleDedupeKey(a.id, instant),
          status: 'PENDING',
          causationId: null,
          depth: 1,
          payload: {},
          error: null,
          errorCode: null,
        })
        // Execuções perdidas durante uma paragem não se acumulam: a seguinte conta a partir de agora.
        const spec = parseCron(a.schedule as string)
        const next =
          typeof spec === 'string'
            ? null
            : nextFire(spec, a.timezone, new Date(Math.max(now.getTime(), instant.getTime())))
        await this.automations.setNextRun(scope, a.id, next)
      }
      return due.length
    }, context)
  }

  // --- execução ------------------------------------------------------------------------------

  async executeDue(context: TenantContext): Promise<number> {
    const claimed = await this.uow.run(
      (scope) => this.runs.claimDue(scope, this.clock(), RUN_BATCH),
      context
    )
    for (const run of claimed) await this.executeOne(context, run)
    return claimed.length
  }

  private async executeOne(context: TenantContext, run: AutomationRun) {
    const deadline = this.clock().getTime() + RUN_TIMEOUT_MS
    try {
      const automation = await this.uow.run(
        (scope) => this.automations.find(scope, run.automationId),
        context
      )
      if (!automation || automation.status !== 'ACTIVE' || !automation.runAsMembershipId) {
        return await this.finishFailed(
          context,
          run,
          'DEAD',
          'AUTOMATION_NOT_ACTIVE',
          'A automação já não está activa.'
        )
      }
      let actor: TenantContext
      try {
        actor = await this.runAs.resolve(
          context.tenantId,
          automation.runAsMembershipId,
          `auto-run-${run.id}`
        )
      } catch (error) {
        return await this.finishFailed(
          context,
          run,
          afterFailure(run.attempts),
          'RUN_AS_UNAVAILABLE',
          error instanceof Error ? error.message : 'O membro da automação já não pode executar.'
        )
      }
      for (let i = run.progress; i < automation.actions.length; i++) {
        const action = automation.actions[i]!
        const handler = findAction(action.type)
        if (!handler)
          throw new ActionError(
            'UNKNOWN_ACTION',
            `A acção «${action.type}» já não está disponível.`
          )
        let params
        try {
          params = resolveParams(action.params, {
            payload: run.payload,
            scheduledFor: run.scheduledFor,
          })
        } catch (error) {
          throw new ActionError(
            'INVALID_PARAMS',
            error instanceof Error ? error.message : 'Parâmetros inválidos.'
          )
        }
        await withDeadline(
          runWithCausation({ runId: run.id, depth: run.depth }, () =>
            handler.execute({ context: actor, params, idempotencyKey: `${run.dedupeKey}#${i}` })
          ),
          deadline - this.clock().getTime()
        )
        await this.uow.run((scope) => this.runs.setProgress(scope, run.id, i + 1), context)
      }
      await this.uow.run((scope) => this.runs.succeed(scope, run.id), context)
    } catch (error) {
      const code =
        error instanceof ActionError
          ? error.code
          : error instanceof TimeoutError
            ? 'TIMEOUT'
            : 'ACTION_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      await this.finishFailed(context, run, afterFailure(run.attempts), code, message)
    }
  }

  private finishFailed(
    context: TenantContext,
    run: AutomationRun,
    status: 'RETRY' | 'DEAD',
    errorCode: string,
    error: string
  ) {
    const delay = status === 'RETRY' ? backoffMs(run.attempts, this.random) : 0
    return this.uow.run(
      (scope) =>
        this.runs.fail(scope, run.id, {
          status: status === 'RETRY' ? 'PENDING' : 'DEAD',
          nextAttemptAt: new Date(this.clock().getTime() + delay),
          error: error.slice(0, 1000),
          errorCode,
        }),
      context
    )
  }
}

class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** Percorre os tenants operacionais. Um tenant suspenso, a fechar ou fechado não é processado: nenhuma escrita empresarial. */
export class AutomationWorker {
  constructor(
    private readonly engine: AutomationEngine,
    private readonly runAs: RunAsResolver,
    private readonly onError: (tenantId: string, error: unknown) => void = () => {}
  ) {}

  async tick(): Promise<TickResult> {
    const total: TickResult = { dispatched: 0, scheduled: 0, executed: 0 }
    for (const tenantId of await this.runAs.operationalTenants()) {
      try {
        const result = await this.engine.processTenant(tenantId)
        total.dispatched += result.dispatched
        total.scheduled += result.scheduled
        total.executed += result.executed
      } catch (error) {
        this.onError(tenantId, error)
      }
    }
    return total
  }
}
