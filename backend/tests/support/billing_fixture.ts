import { billingServices } from '#platform/billing/index'
import type { Tenant } from '#platform/tenants/index'

let counter = 0
export const planCode = () => `t_plan_${process.pid}_${Date.now()}_${counter++}`

/** Publica um plano de teste com o limite de membros indicado (`null` = ilimitado). */
export async function publishPlan(
  members: number | null,
  extra: { entitlements?: unknown; price?: string; code?: string } = {}
) {
  const services = billingServices()
  const draft = await services.createPlan.execute({
    planCode: extra.code ?? planCode(),
    name: 'Plano de teste',
    currency: 'AOA',
    price: extra.price ?? '100.0000',
    billingInterval: 'MONTH',
    limits: { members },
    entitlements: extra.entitlements,
  })
  return services.publishPlan.execute(draft.planCode, draft.revision)
}

/** Dá ao tenant uma assinatura activa de um plano de teste (por omissão, sem limite de membros). */
export async function subscribe(tenant: Tenant, members: number | null = null) {
  const plan = await publishPlan(members)
  await billingServices().assignSubscription.execute({
    tenantId: tenant.id,
    planCode: plan.planCode,
  })
  return plan
}
