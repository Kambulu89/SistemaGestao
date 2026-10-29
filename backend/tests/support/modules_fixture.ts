import { billingServices } from '#platform/billing/index'
import { CODE_MANIFESTS } from '#platform/modules/index'
import { LucidRegistryStore } from '#platform/modules/infrastructure/lucid_modules'
import { SyncRegistry } from '#platform/modules/application/use_cases'
import type { ModuleManifest } from '#platform/modules/domain/module'
import type { Tenant } from '#platform/tenants/index'
import { planCode } from '#tests/support/billing_fixture'

const mod = (
  code: string,
  dependencies: ModuleManifest['dependencies'] = [],
  features: ModuleManifest['features'] = [],
  kind: ModuleManifest['kind'] = 'MODULE'
): ModuleManifest => ({
  code,
  name: code.toUpperCase(),
  kind,
  releaseVersion: '1.2.0',
  minCoreVersion: '0.3.0',
  dependencies,
  features,
})
const dep = (code: string, optional = false, constraint = '*') => ({ code, constraint, optional })
const feature = (code: string, defaultEnabled: boolean) => ({
  code,
  name: code,
  defaultEnabled,
})

/** Catálogo de teste com as dependências da especificação (§C03). */
export const TEST_MANIFESTS: ModuleManifest[] = [
  mod('core', [], [], 'FOUNDATION'),
  mod('crm', [dep('core')], [feature('crm.contacts', true), feature('crm.scoring', false)]),
  // O catálogo é o módulo real (manifesto entregue por código), não uma maquete.
  CODE_MANIFESTS.find((m) => m.code === 'catalog') as ModuleManifest,
  CODE_MANIFESTS.find((m) => m.code === 'customers') as ModuleManifest,
  CODE_MANIFESTS.find((m) => m.code === 'prospecting') as ModuleManifest,
  CODE_MANIFESTS.find((m) => m.code === 'notifications') as ModuleManifest,
  CODE_MANIFESTS.find((m) => m.code === 'documents') as ModuleManifest,
  CODE_MANIFESTS.find((m) => m.code === 'orders') as ModuleManifest,
  CODE_MANIFESTS.find((m) => m.code === 'finance') as ModuleManifest,
  mod(
    'sales',
    [dep('core'), dep('crm', false, '^1'), dep('catalog'), dep('finance', true)],
    [feature('sales.quotes', true), feature('sales.discounts', false)]
  ),
  CODE_MANIFESTS.find((m) => m.code === 'inventory') as ModuleManifest,
  CODE_MANIFESTS.find((m) => m.code === 'invoicing') as ModuleManifest,
  CODE_MANIFESTS.find((m) => m.code === 'procurement') as ModuleManifest,
]

export const syncTestRegistry = () =>
  new SyncRegistry(new LucidRegistryStore()).execute(TEST_MANIFESTS)

/** Plano de teste (publicado e atribuído) que licencia os módulos e funcionalidades indicados. */
export async function license(tenant: Tenant, modules: string[], features: string[] = []) {
  const services = billingServices()
  const draft = await services.createPlan.execute({
    planCode: planCode(),
    name: 'Plano com módulos',
    currency: 'AOA',
    price: '10',
    billingInterval: 'MONTH',
    limits: { members: null },
    entitlements: { modules, features },
  })
  const plan = await services.publishPlan.execute(draft.planCode, draft.revision)
  const current = await services.tenantSubscription.execute(tenant.id).catch(() => null)
  if (current) {
    await services.changePlan.execute({ tenantId: tenant.id, planCode: plan.planCode })
  } else {
    await services.assignSubscription.execute({ tenantId: tenant.id, planCode: plan.planCode })
  }
  return plan
}
