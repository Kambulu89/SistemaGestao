import type { PlanLimit, SubscriptionStatus, UsageLimit } from './subscription.model';

/** `GET /tenant/subscription` (C02): a versão **contratada**, o consumo e os bloqueios. */
export type BackendSubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';
export type BillingInterval = 'MONTH' | 'YEAR';
export type MetricCode = 'members';

export interface PlanLimitsDto {
  /** `null` = ilimitado. */
  readonly members: number | null;
}

export interface PlanDto {
  readonly code: string;
  readonly revision: number;
  readonly name: string;
  /** Decimal em string (nunca número). */
  readonly price: string;
  readonly currency: string;
  readonly billingInterval: BillingInterval;
  readonly limits: PlanLimitsDto;
  readonly entitlements: {
    readonly modules: readonly string[];
    readonly features: readonly string[];
  };
}

export interface UsageDto {
  readonly metric: MetricCode;
  readonly used: number;
  readonly limit: number | null;
  readonly blocked: boolean;
}

export interface SubscriptionChangeDto {
  readonly kind: 'ASSIGNED' | 'UPGRADED' | 'DOWNGRADED' | 'PLAN_CHANGED' | 'STATUS_CHANGED';
  readonly fromStatus: BackendSubscriptionStatus | null;
  readonly toStatus: BackendSubscriptionStatus | null;
  readonly adequacyUntil: string | null;
  readonly occurredAt: string;
}

export interface TenantSubscriptionDto {
  readonly plan: PlanDto;
  readonly subscription: {
    readonly status: BackendSubscriptionStatus;
    readonly entitled: boolean;
    readonly startsAt: string;
    readonly periodEnd: string;
    readonly trialEnd: string | null;
    readonly graceEnd: string | null;
    readonly adequacyUntil: string | null;
    readonly cancelAtPeriodEnd: boolean;
  };
  readonly usage: readonly UsageDto[];
  readonly history: readonly SubscriptionChangeDto[];
}

export const SUBSCRIPTION_STATUS: Readonly<Record<BackendSubscriptionStatus, SubscriptionStatus>> =
  {
    TRIAL: 'trial',
    ACTIVE: 'active',
    PAST_DUE: 'past_due',
    SUSPENDED: 'suspended',
    CANCELLED: 'cancelled',
  };

export const METRIC_LABELS: Readonly<Record<MetricCode, { label: string; unit: string }>> = {
  members: { label: 'Membros', unit: 'membros' },
};

export const toUsageLimit = (usage: UsageDto): UsageLimit => ({
  key: usage.metric,
  label: METRIC_LABELS[usage.metric]?.label ?? usage.metric,
  limit: usage.limit,
  unit: METRIC_LABELS[usage.metric]?.unit,
  used: usage.used,
});

export const toPlanLimits = (plan: PlanDto): readonly PlanLimit[] => [
  {
    key: 'members',
    label: METRIC_LABELS.members.label,
    limit: plan.limits.members,
    unit: METRIC_LABELS.members.unit,
  },
];
