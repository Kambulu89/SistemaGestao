import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { FEATURE_KINDS } from '#modules/subscription/domain/features'
import { TRANSITIONS, type SubscriptionAction } from '#modules/subscription/domain/subscription'
import {
  conn,
  SubscriptionRepository,
  type Plan,
} from '#modules/subscription/infrastructure/subscription_repository'
import { entitlementsFor } from '#modules/subscription/application/entitlements'

const repository = new SubscriptionRepository()
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/

type FeatureInput = { featureCode: string; enabled?: boolean; limitValue?: number | null }

function validatePlan(
  input: {
    code?: string
    name?: string
    description?: string | null
    trialDays?: number
    features?: FeatureInput[]
  },
  creating: boolean
) {
  const issues: ErrorDetail[] = []
  if (creating && !CODE.test(input.code ?? '')) {
    issues.push({
      path: 'code',
      code: 'INVALID_CODE',
      message: 'Código: maiúsculas, números, _ e - (2 a 40).',
    })
  }
  if (input.name !== undefined && (input.name.trim().length < 2 || input.name.length > 120)) {
    issues.push({ path: 'name', code: 'INVALID_NAME', message: 'Nome: 2 a 120 caracteres.' })
  }
  if (
    input.trialDays !== undefined &&
    (!Number.isInteger(input.trialDays) || input.trialDays < 0 || input.trialDays > 365)
  ) {
    issues.push({
      path: 'trialDays',
      code: 'INVALID_TRIAL',
      message: 'Período experimental: 0 a 365 dias.',
    })
  }
  const seen = new Set<string>()
  for (const [i, f] of (input.features ?? []).entries()) {
    const kind = FEATURE_KINDS.get(f.featureCode)
    if (!kind)
      issues.push({
        path: `features.${i}.featureCode`,
        code: 'UNKNOWN_FEATURE',
        message: f.featureCode,
      })
    if (seen.has(f.featureCode))
      issues.push({ path: `features.${i}`, code: 'DUPLICATE', message: f.featureCode })
    seen.add(f.featureCode)
    if (kind === 'BOOLEAN' && f.limitValue !== undefined && f.limitValue !== null) {
      issues.push({
        path: `features.${i}.limitValue`,
        code: 'NOT_A_LIMIT',
        message: 'Só as funcionalidades LIMIT têm limite.',
      })
    }
    if (
      f.limitValue !== undefined &&
      f.limitValue !== null &&
      (!Number.isInteger(f.limitValue) || f.limitValue < 0)
    ) {
      issues.push({
        path: `features.${i}.limitValue`,
        code: 'INVALID_LIMIT',
        message: 'Limite: inteiro ≥ 0.',
      })
    }
  }
  if (issues.length > 0) throw ApiError.validation(issues)
  return (input.features ?? []).map((f) => ({
    featureCode: f.featureCode,
    enabled: f.enabled ?? true,
    limitValue: f.limitValue ?? null,
  }))
}

/** Gestão manual (local) de planos, subscrições e excepções; só para administradores da plataforma. */
export class PlatformSubscriptionService {
  listPlans() {
    return repository.listPlans()
  }

  async getPlan(id: string) {
    const plan = await repository.findPlan(id)
    if (!plan) throw ApiError.notFound()
    return plan
  }

  async createPlan(input: {
    code: string
    name: string
    description?: string | null
    trialDays?: number
    features?: FeatureInput[]
  }) {
    const features = validatePlan(input, true)
    if (await repository.findPlanByCode(input.code))
      throw ApiError.conflict('PLAN_CODE_TAKEN', 'Já existe um plano com este código.')
    const id = await conn().transaction(async (trx) => {
      const planId = await repository.insertPlan(trx, {
        code: input.code,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        trialDays: input.trialDays ?? 0,
      })
      await repository.replacePlanFeatures(trx, planId, features)
      return planId
    })
    return (await repository.findPlan(id))!
  }

  /** Só em DRAFT: um plano publicado é imutável (para mudar, cria-se outro plano). */
  async updatePlan(
    id: string,
    input: {
      expectedVersion: number
      name?: string
      description?: string | null
      trialDays?: number
      features?: FeatureInput[]
    }
  ) {
    const features = validatePlan(input, false)
    await conn().transaction(async (trx) => {
      const plan = await repository.findPlan(id, trx, true)
      if (!plan) throw ApiError.notFound()
      if (plan.status !== 'DRAFT')
        throw ApiError.conflict('PLAN_IMMUTABLE', 'Um plano publicado não se altera.')
      const ok = await repository.updatePlan(trx, id, input.expectedVersion, {
        name: input.name?.trim() ?? plan.name,
        description:
          input.description === undefined ? plan.description : input.description?.trim() || null,
        trialDays: input.trialDays ?? plan.trialDays,
      })
      if (!ok) throw ApiError.versionConflict(plan.version)
      if (input.features) await repository.replacePlanFeatures(trx, id, features)
    })
    return (await repository.findPlan(id))!
  }

  async setPlanStatus(id: string, status: 'ACTIVE' | 'RETIRED') {
    await conn().transaction(async (trx) => {
      const plan = await repository.findPlan(id, trx, true)
      if (!plan) throw ApiError.notFound()
      const allowed = status === 'ACTIVE' ? plan.status === 'DRAFT' : plan.status === 'ACTIVE'
      if (!allowed)
        throw ApiError.conflict('PLAN_STATE', `Transição inválida: ${plan.status} → ${status}.`)
      await repository.setPlanStatus(trx, id, status)
    })
    return (await repository.findPlan(id))!
  }

  async tenantSubscription(tenantId: string) {
    const { subscription, status, features } = await entitlementsFor(tenantId)
    return {
      subscription,
      effectiveStatus: status,
      entitlements: [...features.values()],
      overrides: await repository.overrides(tenantId),
      history: await repository.events(tenantId),
    }
  }

  /** Inicia a subscrição de um tenant sem subscrição corrente: em período experimental (se o plano tiver) ou activa. */
  async start(
    tenantId: string,
    input: { planId: string; trial?: boolean; reason?: string | null },
    actorUserId: string | null
  ) {
    return conn().transaction(async (trx) => {
      await trx.rawQuery('select id from tenants where id = ? for update', [tenantId])
      if (await repository.currentSubscription(tenantId, trx, true)) {
        throw ApiError.conflict(
          'SUBSCRIPTION_EXISTS',
          'O tenant já tem uma subscrição corrente; altere-a ou cancele-a.'
        )
      }
      const plan = await this.activePlan(input.planId, trx)
      const trial = input.trial ?? plan.trialDays > 0
      if (trial && plan.trialDays === 0) {
        throw ApiError.validation([
          { path: 'trial', code: 'NO_TRIAL', message: 'O plano não tem período experimental.' },
        ])
      }
      const status = trial ? 'TRIALING' : 'ACTIVE'
      const trialEndsAt = trial ? new Date(Date.now() + plan.trialDays * 86_400_000) : null
      const id = await repository.insertSubscription(trx, {
        tenantId,
        planId: plan.id,
        status,
        trialEndsAt,
      })
      await repository.addEvent(trx, {
        subscriptionId: id,
        tenantId,
        action: 'START',
        fromStatus: null,
        toStatus: status,
        planId: plan.id,
        actorUserId,
        reason: input.reason ?? null,
      })
      return repository.findSubscription(id, trx)
    })
  }

  async transition(
    subscriptionId: string,
    action: Exclude<SubscriptionAction, 'START'>,
    input: { expectedVersion: number; reason?: string | null; planId?: string },
    actorUserId: string
  ) {
    return conn().transaction(async (trx) => {
      const sub = await repository.findSubscription(subscriptionId, trx, true)
      if (!sub) throw ApiError.notFound()
      if (sub.version !== input.expectedVersion) throw ApiError.versionConflict(sub.version)
      if ((action === 'SUSPEND' || action === 'CANCEL') && !input.reason?.trim()) {
        throw ApiError.validation([
          { path: 'reason', code: 'REASON_REQUIRED', message: 'Indique o motivo.' },
        ])
      }
      let status = sub.status
      let planId = sub.planId
      if (action === 'CHANGE_PLAN') {
        if (sub.status === 'CANCELLED')
          throw ApiError.conflict('SUBSCRIPTION_STATE', 'A subscrição está cancelada.')
        planId = (await this.activePlan(input.planId ?? '', trx)).id
        if (planId === sub.planId)
          throw ApiError.conflict('SAME_PLAN', 'A subscrição já está neste plano.')
      } else {
        const rule = TRANSITIONS[action]
        if (!rule.from.includes(sub.status)) {
          throw ApiError.conflict(
            'SUBSCRIPTION_STATE',
            `Transição inválida: ${sub.status} → ${rule.to}.`
          )
        }
        status = rule.to
      }
      const endsAt = status === 'CANCELLED' ? new Date() : null
      await repository.updateSubscription(trx, sub.id, sub.version, { status, planId, endsAt })
      await repository.addEvent(trx, {
        subscriptionId: sub.id,
        tenantId: sub.tenantId,
        action,
        fromStatus: sub.status,
        toStatus: status,
        planId,
        actorUserId,
        reason: input.reason ?? null,
      })
      return repository.findSubscription(sub.id, trx)
    })
  }

  async setOverride(
    tenantId: string,
    featureCode: string,
    input: {
      enabled: boolean
      limitValue?: number | null
      reason: string
      expiresAt?: string | null
    },
    actorUserId: string
  ) {
    const kind = FEATURE_KINDS.get(featureCode)
    if (!kind) throw ApiError.notFound()
    const issues: ErrorDetail[] = []
    if (!input.reason?.trim())
      issues.push({ path: 'reason', code: 'REASON_REQUIRED', message: 'Indique o motivo.' })
    if (kind === 'BOOLEAN' && input.limitValue !== undefined && input.limitValue !== null) {
      issues.push({
        path: 'limitValue',
        code: 'NOT_A_LIMIT',
        message: 'Só as funcionalidades LIMIT têm limite.',
      })
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
    if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
      issues.push({
        path: 'expiresAt',
        code: 'INVALID_EXPIRY',
        message: 'Validade: data futura (ISO 8601).',
      })
    }
    if (issues.length > 0) throw ApiError.validation(issues)
    await repository.upsertOverride({
      tenantId,
      featureCode,
      enabled: input.enabled,
      limitValue: input.limitValue ?? null,
      reason: input.reason.trim(),
      expiresAt,
      createdBy: actorUserId,
    })
    return this.tenantSubscription(tenantId)
  }

  async removeOverride(tenantId: string, featureCode: string) {
    if (!(await repository.deleteOverride(tenantId, featureCode))) throw ApiError.notFound()
    return this.tenantSubscription(tenantId)
  }

  private async activePlan(
    planId: string,
    trx: Parameters<SubscriptionRepository['findPlan']>[1]
  ): Promise<Plan> {
    const plan = /^[0-9a-f-]{36}$/i.test(planId) ? await repository.findPlan(planId, trx) : null
    if (!plan)
      throw ApiError.validation([
        { path: 'planId', code: 'UNKNOWN_PLAN', message: 'O plano não existe.' },
      ])
    if (plan.status !== 'ACTIVE') {
      throw ApiError.conflict(
        'PLAN_NOT_ACTIVE',
        'Só se subscreve um plano publicado e não retirado.'
      )
    }
    return plan
  }
}
