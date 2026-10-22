import { DateTime } from 'luxon'
import { ApiError } from '#core/http/api_error'
import {
  BillingRuleError,
  METRIC_CODES,
  canTransitionSubscription,
  classifyChange,
  grantsEntitlements,
  isValidPlanCode,
  limitViolations,
  parseCurrency,
  parseEntitlements,
  parseLimits,
  parsePrice,
  BILLING_INTERVALS,
  type BillingInterval,
  type MetricCode,
  type PlanVersion,
  type Subscription,
  type SubscriptionStatus,
} from '#platform/billing/domain/plan'
import type {
  Clock,
  PlanStore,
  SubscriptionChange,
  SubscriptionStore,
  UsageReader,
} from '#platform/billing/application/ports'

const invalid = (path: string, code: string, message: string) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [{ path, code, message }])

/** Regras de domínio violadas → erro de validação com a forma da API. */
function validated<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof BillingRuleError) throw invalid(error.path, error.code, error.message)
    throw error
  }
}

const systemClock: Clock = { now: () => new Date() }

export interface PlanInput {
  planCode: string
  name: string
  currency: string
  price: string
  billingInterval: string
  limits: unknown
  entitlements?: unknown
}

export class CreatePlanVersion {
  constructor(private readonly plans: PlanStore) {}

  async execute(input: PlanInput): Promise<PlanVersion> {
    const draft = validated(() => {
      const planCode = input.planCode.trim().toLowerCase()
      if (!isValidPlanCode(planCode)) {
        throw new BillingRuleError(
          'planCode',
          'INVALID_CODE',
          'Código: 2–60 caracteres a-z, 0-9, _.'
        )
      }
      const name = input.name.trim()
      if (!name || name.length > 160) {
        throw new BillingRuleError('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).')
      }
      if (!BILLING_INTERVALS.includes(input.billingInterval as BillingInterval)) {
        throw new BillingRuleError('billingInterval', 'INVALID_INTERVAL', 'MONTH ou YEAR.')
      }
      return {
        planCode,
        name,
        currency: parseCurrency(input.currency),
        price: parsePrice(input.price),
        billingInterval: input.billingInterval as BillingInterval,
        limits: parseLimits(input.limits),
        entitlements: parseEntitlements(input.entitlements),
      }
    })
    return this.plans.insertDraft(draft)
  }
}

abstract class PlanTransition {
  constructor(
    protected readonly plans: PlanStore,
    protected readonly clock: Clock = systemClock
  ) {}

  protected async transition(
    planCode: string,
    revision: number,
    from: PlanVersion['status'],
    to: PlanVersion['status']
  ) {
    const plan = await this.plans.find(planCode.trim().toLowerCase(), revision)
    if (!plan) throw ApiError.notFound('Versão de plano não encontrada.')
    if (plan.status === to) return plan
    const updated = await this.plans.setStatus(plan.id, from, to, this.clock.now())
    if (!updated) {
      throw ApiError.conflict(
        'INVALID_STATE_TRANSITION',
        `Só uma versão ${from} pode passar a ${to} (actual: ${plan.status}).`
      )
    }
    return updated
  }
}

/** Publicar torna a versão imutável (preços e limites nunca mudam retroactivamente). */
export class PublishPlanVersion extends PlanTransition {
  execute(planCode: string, revision: number) {
    return this.transition(planCode, revision, 'DRAFT', 'PUBLISHED')
  }
}

/** Retirar impede novas assinaturas da versão; as existentes mantêm os seus termos. */
export class RetirePlanVersion extends PlanTransition {
  execute(planCode: string, revision: number) {
    return this.transition(planCode, revision, 'PUBLISHED', 'RETIRED')
  }
}

export class ListPlans {
  constructor(private readonly plans: PlanStore) {}
  execute() {
    return this.plans.list()
  }
}

async function publishedVersion(plans: PlanStore, planCode: string, revision?: number) {
  const code = planCode.trim().toLowerCase()
  const plan = revision ? await plans.find(code, revision) : await plans.latestPublished(code)
  if (!plan) throw ApiError.notFound('Plano não encontrado.')
  if (plan.status !== 'PUBLISHED') {
    throw ApiError.conflict('PLAN_NOT_PUBLISHED', 'Só versões publicadas podem ser contratadas.')
  }
  return plan
}

const periodEnd = (from: Date, interval: BillingInterval) =>
  DateTime.fromJSDate(from, { zone: 'utc' })
    .plus(interval === 'MONTH' ? { months: 1 } : { years: 1 })
    .toJSDate()

/** Atribui o plano a um tenant. Repetir o mesmo pedido é idempotente; outro plano exige `ChangePlan`. */
export class AssignSubscription {
  constructor(
    private readonly plans: PlanStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly clock: Clock = systemClock
  ) {}

  async execute(input: {
    tenantId: string
    planCode: string
    revision?: number
    trialDays?: number
  }): Promise<Subscription> {
    if (
      input.trialDays !== undefined &&
      !(Number.isInteger(input.trialDays) && input.trialDays >= 1 && input.trialDays <= 90)
    ) {
      throw invalid('trialDays', 'INVALID_TRIAL', 'O período de teste é de 1 a 90 dias.')
    }
    const plan = await publishedVersion(this.plans, input.planCode, input.revision)
    const now = this.clock.now()
    return this.subscriptions.exclusive(input.tenantId, async (tx) => {
      const current = await tx.current()
      if (current) {
        if (current.planVersionId === plan.id) return current
        throw ApiError.conflict(
          'SUBSCRIPTION_EXISTS',
          'O tenant já tem uma assinatura; use a mudança de plano.'
        )
      }
      const trialEnd = input.trialDays
        ? DateTime.fromJSDate(now).plus({ days: input.trialDays }).toJSDate()
        : null
      const created = await tx.create({
        planVersionId: plan.id,
        status: trialEnd ? 'TRIAL' : 'ACTIVE',
        startsAt: now,
        periodEnd: periodEnd(now, plan.billingInterval),
        trialEnd,
        graceEnd: null,
      })
      await tx.record({
        subscriptionId: created.id,
        kind: 'ASSIGNED',
        fromPlanVersionId: null,
        toPlanVersionId: plan.id,
        fromStatus: null,
        toStatus: created.status,
        adequacyUntil: null,
        detail: { planCode: plan.planCode, revision: plan.revision },
      })
      return created
    })
  }
}

/**
 * Muda a versão contratada. Upgrade aplica-se logo. Um downgrade (ou troca) que deixe o consumo acima
 * dos novos limites falha com 409 e a lista das métricas, **excepto** se for pedido um período de
 * adequação: o plano muda, nada é eliminado e o excesso só bloqueia novos consumos.
 */
export class ChangePlan {
  constructor(
    private readonly plans: PlanStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly usage: UsageReader,
    private readonly clock: Clock = systemClock
  ) {}

  async execute(input: {
    tenantId: string
    planCode: string
    revision?: number
    adequacyDays?: number
  }): Promise<Subscription> {
    if (
      input.adequacyDays !== undefined &&
      !(
        Number.isInteger(input.adequacyDays) &&
        input.adequacyDays >= 1 &&
        input.adequacyDays <= 180
      )
    ) {
      throw invalid('adequacyDays', 'INVALID_ADEQUACY', 'O período de adequação é de 1 a 180 dias.')
    }
    const target = await publishedVersion(this.plans, input.planCode, input.revision)
    const now = this.clock.now()

    return this.subscriptions.exclusive(input.tenantId, async (tx) => {
      const current = await tx.current()
      if (!current) throw ApiError.notFound('O tenant não tem assinatura.')
      if (current.planVersionId === target.id) return current
      const from = await this.plans.findById(current.planVersionId)
      if (!from) throw new Error('Versão de plano da assinatura em falta')

      const violations = limitViolations(target.limits, await this.usage.usage(input.tenantId))
      if (violations.length > 0 && input.adequacyDays === undefined) {
        throw ApiError.conflict(
          'PLAN_LIMITS_EXCEEDED',
          'O consumo actual excede os limites do novo plano; resolva-o ou peça um período de adequação.',
          violations.map((v) => ({
            path: `limits.${v.metric}`,
            code: 'LIMIT_EXCEEDED',
            message: `Em uso: ${v.used}; limite do novo plano: ${v.limit}.`,
          }))
        )
      }
      const adequacyUntil =
        violations.length > 0
          ? DateTime.fromJSDate(now).plus({ days: input.adequacyDays }).toJSDate()
          : null
      const updated = await tx.update(current.id, {
        planVersionId: target.id,
        adequacyUntil,
      })
      await tx.record({
        subscriptionId: current.id,
        kind: classifyChange(from.limits, target.limits),
        fromPlanVersionId: from.id,
        toPlanVersionId: target.id,
        fromStatus: current.status,
        toStatus: updated.status,
        adequacyUntil,
        detail: { violations },
      })
      return updated
    })
  }
}

export class SetSubscriptionStatus {
  constructor(
    private readonly subscriptions: SubscriptionStore,
    private readonly clock: Clock = systemClock
  ) {}

  async execute(input: {
    tenantId: string
    status: SubscriptionStatus
    graceDays?: number
  }): Promise<Subscription> {
    const now = this.clock.now()
    return this.subscriptions.exclusive(input.tenantId, async (tx) => {
      const current = await tx.current()
      if (!current) throw ApiError.notFound('O tenant não tem assinatura.')
      if (current.status === input.status) return current
      if (!canTransitionSubscription(current.status, input.status)) {
        throw ApiError.conflict(
          'INVALID_STATE_TRANSITION',
          `Não é possível passar de ${current.status} para ${input.status}.`
        )
      }
      const grace = input.graceDays ?? 7
      if (input.status === 'PAST_DUE' && !(Number.isInteger(grace) && grace >= 1 && grace <= 90)) {
        throw invalid('graceDays', 'INVALID_GRACE', 'O período de tolerância é de 1 a 90 dias.')
      }
      const updated = await tx.update(current.id, {
        status: input.status,
        graceEnd:
          input.status === 'PAST_DUE'
            ? DateTime.fromJSDate(now).plus({ days: grace }).toJSDate()
            : null,
      })
      await tx.record({
        subscriptionId: current.id,
        kind: 'STATUS_CHANGED',
        fromPlanVersionId: current.planVersionId,
        toPlanVersionId: current.planVersionId,
        fromStatus: current.status,
        toStatus: input.status,
        adequacyUntil: current.adequacyUntil,
        detail: {},
      })
      return updated
    })
  }
}

export interface UsageLine {
  metric: MetricCode
  used: number
  /** `null` = ilimitado. */
  limit: number | null
  /** Novos consumos desta métrica estão bloqueados (limite atingido ou sem direitos activos). */
  blocked: boolean
}

export interface SubscriptionView {
  plan: PlanVersion
  subscription: Subscription
  entitled: boolean
  usage: UsageLine[]
  history: SubscriptionChange[]
}

/** O que o tenant contratou, o que consome e o que está bloqueado (preços e limites da versão contratada). */
export class GetTenantSubscription {
  constructor(
    private readonly plans: PlanStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly usage: UsageReader,
    private readonly clock: Clock = systemClock
  ) {}

  async execute(tenantId: string): Promise<SubscriptionView> {
    const subscription = await this.subscriptions.findCurrent(tenantId)
    if (!subscription) throw ApiError.notFound('O tenant não tem assinatura.')
    const plan = await this.plans.findById(subscription.planVersionId)
    if (!plan) throw new Error('Versão de plano da assinatura em falta')
    const entitled = grantsEntitlements(subscription, this.clock.now())
    const used = await this.usage.usage(tenantId)
    return {
      plan,
      subscription,
      entitled,
      usage: METRIC_CODES.map((metric) => {
        const limit = plan.limits[metric]
        return {
          metric,
          used: used[metric],
          limit,
          blocked: !entitled || (limit !== null && used[metric] >= limit),
        }
      }),
      history: await this.subscriptions.history(tenantId, 50),
    }
  }
}

/**
 * Limite efectivo de uma métrica para o tenant. Sem assinatura, ou com direitos suspensos/expirados, o
 * limite é **0** (nega por omissão): nunca se assume "ilimitado" por falta de dados.
 */
export class ResolveLimit {
  constructor(
    private readonly plans: PlanStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly clock: Clock = systemClock
  ) {}

  async execute(tenantId: string, metric: MetricCode): Promise<number | null> {
    const subscription = await this.subscriptions.findCurrent(tenantId)
    if (!subscription || !grantsEntitlements(subscription, this.clock.now())) return 0
    const plan = await this.plans.findById(subscription.planVersionId)
    return plan ? plan.limits[metric] : 0
  }
}
