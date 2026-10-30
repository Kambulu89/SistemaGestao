/**
 * Planos, assinaturas e limites (C02). Direitos comerciais: **não** substituem as permissões dos
 * utilizadores. Domínio puro: sem I/O nem dependências de framework.
 */

/** Métricas com limite. `supportsUnlimited`: só estas aceitam `null` (= ilimitado). */
export const METRICS = {
  /** Memberships ocupadas (não "LEFT"), não pessoas. */
  members: { supportsUnlimited: true },
} as const satisfies Record<string, { supportsUnlimited: boolean }>

export type MetricCode = keyof typeof METRICS
export const METRIC_CODES = Object.keys(METRICS) as MetricCode[]

/** Valor por métrica; `null` = ilimitado (só onde a métrica o suporta). */
export type PlanLimits = Record<MetricCode, number | null>

export interface Entitlements {
  modules: string[]
  features: string[]
}

export const PLAN_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]
export const BILLING_INTERVALS = ['MONTH', 'YEAR'] as const
export type BillingInterval = (typeof BILLING_INTERVALS)[number]

export interface PlanVersion {
  id: string
  planCode: string
  revision: number
  name: string
  currency: string
  /** Decimal como string (nunca float). */
  price: string
  billingInterval: BillingInterval
  limits: PlanLimits
  entitlements: Entitlements
  status: PlanStatus
  publishedAt: Date | null
}

export const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export interface Subscription {
  id: string
  tenantId: string
  planVersionId: string
  status: SubscriptionStatus
  startsAt: Date
  periodEnd: Date
  trialEnd: Date | null
  graceEnd: Date | null
  /** Período de adequação de um downgrade que excede os limites; nada é eliminado. */
  adequacyUntil: Date | null
  externalCustomerId: string | null
  cancelAtPeriodEnd: boolean
  version: number
}

export type ChangeKind = 'ASSIGNED' | 'UPGRADED' | 'DOWNGRADED' | 'PLAN_CHANGED' | 'STATUS_CHANGED'

export class BillingRuleError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const CODE = /^[a-z][a-z0-9_]{1,59}$/
export const isValidPlanCode = (code: string) => CODE.test(code)
const ITEM_CODE = /^[a-z][a-z0-9_.-]{1,59}$/
const MONEY = /^\d{1,15}(\.\d{1,4})?$/
const CURRENCY = /^[A-Z]{3}$/

export function parsePrice(value: string): string {
  if (!MONEY.test(value)) {
    throw new BillingRuleError('price', 'INVALID_PRICE', 'O preço é um decimal ≥ 0 (até 4 casas).')
  }
  return value
}

export function parseCurrency(value: string): string {
  const code = value.trim().toUpperCase()
  if (!CURRENCY.test(code)) {
    throw new BillingRuleError('currency', 'INVALID_CURRENCY', 'Moeda ISO 4217 de 3 letras.')
  }
  return code
}

/** Todas as métricas têm de estar definidas (sem omissões ambíguas); `null` só onde é suportado. */
export function parseLimits(raw: unknown): PlanLimits {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BillingRuleError('limits', 'INVALID_LIMITS', 'Os limites são um objecto por métrica.')
  }
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!(key in METRICS)) {
      throw new BillingRuleError(`limits.${key}`, 'UNKNOWN_METRIC', 'Métrica desconhecida.')
    }
  }
  const limits = {} as PlanLimits
  for (const metric of METRIC_CODES) {
    const value = input[metric]
    if (value === undefined) {
      throw new BillingRuleError(`limits.${metric}`, 'MISSING_LIMIT', 'Defina o limite da métrica.')
    }
    if (value === null) {
      if (!METRICS[metric].supportsUnlimited) {
        throw new BillingRuleError(
          `limits.${metric}`,
          'UNLIMITED_NOT_SUPPORTED',
          'Esta métrica não suporta ilimitado.'
        )
      }
      limits[metric] = null
    } else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      limits[metric] = value
    } else {
      throw new BillingRuleError(
        `limits.${metric}`,
        'INVALID_LIMIT',
        'O limite é um inteiro ≥ 0 ou null.'
      )
    }
  }
  return limits
}

/** Códigos de módulos e funcionalidades licenciados. A existência no registo valida-se em C03. */
export function parseEntitlements(raw: unknown): Entitlements {
  const input = (raw ?? {}) as { modules?: unknown; features?: unknown }
  const list = (value: unknown, path: string): string[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 200) {
      throw new BillingRuleError(path, 'INVALID_ENTITLEMENTS', 'Lista de códigos (máx. 200).')
    }
    const codes = value.map((item) => (typeof item === 'string' ? item.trim() : ''))
    if (codes.some((c) => !ITEM_CODE.test(c)) || new Set(codes).size !== codes.length) {
      throw new BillingRuleError(path, 'INVALID_ENTITLEMENTS', 'Códigos inválidos ou repetidos.')
    }
    return codes
  }
  return {
    modules: list(input.modules, 'entitlements.modules'),
    features: list(input.features, 'entitlements.features'),
  }
}

/** A assinatura concede direitos (quotas) agora? Suspensa/cancelada/expirada não concede. */
export function grantsEntitlements(
  subscription: Pick<Subscription, 'status' | 'trialEnd' | 'graceEnd'>,
  now: Date
): boolean {
  switch (subscription.status) {
    case 'ACTIVE':
      return true
    case 'TRIAL':
      return subscription.trialEnd === null || subscription.trialEnd > now
    case 'PAST_DUE':
      return subscription.graceEnd !== null && subscription.graceEnd > now
    default:
      return false
  }
}

export interface LimitViolation {
  metric: MetricCode
  used: number
  limit: number
}

/** Métricas cujo consumo actual excede o limite do novo plano. */
export function limitViolations(
  limits: PlanLimits,
  usage: Record<MetricCode, number>
): LimitViolation[] {
  return METRIC_CODES.flatMap((metric) => {
    const limit = limits[metric]
    return limit !== null && usage[metric] > limit ? [{ metric, used: usage[metric], limit }] : []
  })
}

/** Menos direitos? Compara só limites (preço não decide); `null` (ilimitado) vale mais que qualquer número. */
export function classifyChange(
  from: PlanLimits,
  to: PlanLimits
): 'UPGRADED' | 'DOWNGRADED' | 'PLAN_CHANGED' {
  const rank = (value: number | null) => (value === null ? Number.POSITIVE_INFINITY : value)
  let lower = false
  let higher = false
  for (const metric of METRIC_CODES) {
    if (rank(to[metric]) < rank(from[metric])) lower = true
    if (rank(to[metric]) > rank(from[metric])) higher = true
  }
  if (lower) return 'DOWNGRADED'
  return higher ? 'UPGRADED' : 'PLAN_CHANGED'
}

const TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  TRIAL: ['ACTIVE', 'SUSPENDED', 'CANCELLED'],
  ACTIVE: ['PAST_DUE', 'SUSPENDED', 'CANCELLED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CANCELLED'],
  SUSPENDED: ['ACTIVE', 'CANCELLED'],
  CANCELLED: [],
}
export const canTransitionSubscription = (from: SubscriptionStatus, to: SubscriptionStatus) =>
  TRANSITIONS[from].includes(to)
