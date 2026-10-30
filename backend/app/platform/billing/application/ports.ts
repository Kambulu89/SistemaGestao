import type {
  ChangeKind,
  MetricCode,
  PlanVersion,
  Subscription,
  SubscriptionStatus,
} from '#platform/billing/domain/plan'

export interface NewPlanVersion {
  planCode: string
  name: string
  currency: string
  price: string
  billingInterval: PlanVersion['billingInterval']
  limits: PlanVersion['limits']
  entitlements: PlanVersion['entitlements']
}

export interface PlanStore {
  /** Cria a próxima revisão (DRAFT) do plano de forma atómica. */
  insertDraft(input: NewPlanVersion): Promise<PlanVersion>
  findById(id: string): Promise<PlanVersion | null>
  find(planCode: string, revision: number): Promise<PlanVersion | null>
  /** Última revisão PUBLISHED. */
  latestPublished(planCode: string): Promise<PlanVersion | null>
  list(): Promise<PlanVersion[]>
  /** `null` se a versão deixou de estar no estado esperado. */
  setStatus(
    id: string,
    from: PlanVersion['status'],
    to: PlanVersion['status'],
    now: Date
  ): Promise<PlanVersion | null>
}

export interface SubscriptionChange {
  id: string
  kind: ChangeKind
  fromPlanVersionId: string | null
  toPlanVersionId: string | null
  fromStatus: SubscriptionStatus | null
  toStatus: SubscriptionStatus | null
  adequacyUntil: Date | null
  detail: Record<string, unknown>
  occurredAt: Date
}

/** Operações dentro da transacção que bloqueia a assinatura do tenant (`FOR UPDATE`). */
export interface LockedSubscription {
  current(): Promise<Subscription | null>
  create(input: {
    planVersionId: string
    status: SubscriptionStatus
    startsAt: Date
    periodEnd: Date
    trialEnd: Date | null
    graceEnd: Date | null
  }): Promise<Subscription>
  update(
    id: string,
    patch: Partial<
      Pick<
        Subscription,
        'planVersionId' | 'status' | 'adequacyUntil' | 'graceEnd' | 'trialEnd' | 'cancelAtPeriodEnd'
      >
    >
  ): Promise<Subscription>
  record(
    change: Omit<SubscriptionChange, 'id' | 'occurredAt'> & { subscriptionId: string }
  ): Promise<void>
}

export interface SubscriptionStore {
  /** Serializa as alterações da assinatura de um tenant (e cria-a de forma única). */
  exclusive<T>(tenantId: string, work: (tx: LockedSubscription) => Promise<T>): Promise<T>
  findCurrent(tenantId: string): Promise<Subscription | null>
  history(tenantId: string, limit: number): Promise<SubscriptionChange[]>
}

/** Consumo actual por métrica (memberships ocupadas, etc.). */
export interface UsageReader {
  usage(tenantId: string): Promise<Record<MetricCode, number>>
}

export interface Clock {
  now(): Date
}
