export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';

/** Limite de utilização definido por um plano. `limit: null` = ilimitado. */
export interface PlanLimit {
  readonly key: string;
  readonly label: string;
  readonly limit: number | null;
  readonly unit?: string;
}

/** Limite com o consumo actual do tenant. */
export interface UsageLimit extends PlanLimit {
  readonly used: number;
}

/** Oferta comercial: módulos incluídos e limites. */
export interface Plan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  /** Ids dos módulos incluídos (ver `moduleId`). */
  readonly moduleIds: readonly string[];
  readonly limits: readonly PlanLimit[];
}

/**
 * Contrato de um tenant: os direitos (módulos) e limites efectivos.
 * `moduleIds` já inclui eventuais módulos adicionais ao plano, resolvido pelo backend.
 */
export interface Subscription {
  readonly id: string;
  readonly tenantId: string;
  readonly planCode: string;
  readonly status: SubscriptionStatus;
  readonly startedAt: string;
  readonly renewsAt: string | null;
  readonly moduleIds: readonly string[];
  readonly limits: readonly UsageLimit[];
}

/** Estados em que a subscrição permite usar os módulos contratados. */
export function isSubscriptionUsable(subscription: Subscription | null): boolean {
  return (
    subscription !== null &&
    (subscription.status === 'active' ||
      subscription.status === 'trial' ||
      subscription.status === 'past_due')
  );
}
