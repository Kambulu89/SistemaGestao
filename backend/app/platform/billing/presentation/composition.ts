import {
  AssignSubscription,
  ChangePlan,
  CreatePlanVersion,
  GetTenantSubscription,
  ListPlans,
  PublishPlanVersion,
  ResolveEntitlements,
  ResolveLimit,
  RetirePlanVersion,
  SetSubscriptionStatus,
} from '#platform/billing/application/use_cases'
import {
  LucidPlanStore,
  LucidSubscriptionStore,
  LucidUsageReader,
} from '#platform/billing/infrastructure/lucid_billing'

function build() {
  const plans = new LucidPlanStore()
  const subscriptions = new LucidSubscriptionStore()
  const usage = new LucidUsageReader()
  return {
    createPlan: new CreatePlanVersion(plans),
    publishPlan: new PublishPlanVersion(plans),
    retirePlan: new RetirePlanVersion(plans),
    listPlans: new ListPlans(plans),
    assignSubscription: new AssignSubscription(plans, subscriptions),
    changePlan: new ChangePlan(plans, subscriptions, usage),
    setSubscriptionStatus: new SetSubscriptionStatus(subscriptions),
    tenantSubscription: new GetTenantSubscription(plans, subscriptions, usage),
    resolveLimit: new ResolveLimit(plans, subscriptions),
    resolveEntitlements: new ResolveEntitlements(plans, subscriptions),
  }
}

let instance: ReturnType<typeof build> | undefined

export const billingServices = () => (instance ??= build())
