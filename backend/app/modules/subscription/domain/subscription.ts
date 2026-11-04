export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'
/** Estado efectivo: `EXPIRED` deriva de um período experimental ou de uma data de fim já passados (não se grava). */
export type EffectiveStatus = SubscriptionStatus | 'EXPIRED' | 'NONE'
export type SubscriptionAction =
  'START' | 'ACTIVATE' | 'SUSPEND' | 'REACTIVATE' | 'CANCEL' | 'CHANGE_PLAN'

/** Transições permitidas (gestão manual pela plataforma). CANCELLED é final: uma nova subscrição recomeça com START. */
export const TRANSITIONS: Record<
  Exclude<SubscriptionAction, 'START' | 'CHANGE_PLAN'>,
  {
    from: readonly SubscriptionStatus[]
    to: SubscriptionStatus
  }
> = {
  ACTIVATE: { from: ['TRIALING'], to: 'ACTIVE' },
  SUSPEND: { from: ['TRIALING', 'ACTIVE'], to: 'SUSPENDED' },
  REACTIVATE: { from: ['SUSPENDED'], to: 'ACTIVE' },
  CANCEL: { from: ['TRIALING', 'ACTIVE', 'SUSPENDED'], to: 'CANCELLED' },
}

export function effectiveStatus(
  sub: { status: SubscriptionStatus; trialEndsAt: Date | null; endsAt: Date | null } | null,
  now: Date
): EffectiveStatus {
  if (!sub) return 'NONE'
  if (sub.status === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt <= now) return 'EXPIRED'
  if ((sub.status === 'TRIALING' || sub.status === 'ACTIVE') && sub.endsAt && sub.endsAt <= now)
    return 'EXPIRED'
  return sub.status
}

export interface Entitlement {
  code: string
  enabled: boolean
  /** Só para funcionalidades LIMIT; `null` = sem limite. */
  limit: number | null
  source: 'PLAN' | 'OVERRIDE' | 'NONE'
}

/**
 * Funcionalidades efectivas de um tenant: as do plano (só com subscrição em TRIALING ou ACTIVE efectivos) e, por cima,
 * as excepções não expiradas. Sem subscrição válida, nada contratável está disponível (negar por omissão).
 */
export function computeEntitlements(
  catalog: readonly { code: string }[],
  status: EffectiveStatus,
  planFeatures: readonly { featureCode: string; enabled: boolean; limitValue: number | null }[],
  overrides: readonly {
    featureCode: string
    enabled: boolean
    limitValue: number | null
    expiresAt: Date | null
  }[],
  now: Date
): Map<string, Entitlement> {
  const usable = status === 'TRIALING' || status === 'ACTIVE'
  const result = new Map<string, Entitlement>()
  for (const { code } of catalog) {
    const fromPlan = usable ? planFeatures.find((f) => f.featureCode === code) : undefined
    result.set(code, {
      code,
      enabled: fromPlan?.enabled ?? false,
      limit: fromPlan?.limitValue ?? null,
      source: fromPlan ? 'PLAN' : 'NONE',
    })
  }
  for (const o of overrides) {
    if (o.expiresAt && o.expiresAt <= now) continue
    if (!result.has(o.featureCode)) continue
    result.set(o.featureCode, {
      code: o.featureCode,
      enabled: o.enabled,
      limit: o.limitValue,
      source: 'OVERRIDE',
    })
  }
  return result
}
