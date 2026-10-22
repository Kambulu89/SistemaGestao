/** API pública do módulo de planos e assinaturas (C02). Outros módulos importam **apenas** daqui. */
export {
  BILLING_INTERVALS,
  METRIC_CODES,
  SUBSCRIPTION_STATUSES,
  type MetricCode,
  type PlanVersion,
  type Subscription,
  type SubscriptionStatus,
} from '#platform/billing/domain/plan'
export type {
  LicensedEntitlements,
  SubscriptionView,
} from '#platform/billing/application/use_cases'
export { billingServices } from '#platform/billing/presentation/composition'
