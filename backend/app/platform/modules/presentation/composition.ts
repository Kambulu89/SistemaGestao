import { LucidTenantDatabase } from '#core/tenancy/index'
import {
  DisableModule,
  EnableModule,
  IsFeatureEnabled,
  ListEffectiveFeatures,
  ListModules,
  SetFeatureOverride,
  SyncRegistry,
} from '#platform/modules/application/use_cases'
import {
  BillingLicenceReader,
  CodeModuleActivator,
  LucidRegistryStore,
  LucidTenantModuleStore,
} from '#platform/modules/infrastructure/lucid_modules'
import { MODULE_ACTIVATORS } from '#platform/modules/manifests'

function build() {
  const uow = new LucidTenantDatabase()
  const registry = new LucidRegistryStore()
  const tenantModules = new LucidTenantModuleStore()
  const licences = new BillingLicenceReader()
  return {
    syncRegistry: new SyncRegistry(registry),
    listModules: new ListModules(uow, registry, tenantModules, licences),
    listFeatures: new ListEffectiveFeatures(uow, registry, tenantModules, licences),
    isFeatureEnabled: new IsFeatureEnabled(uow, registry, tenantModules, licences),
    enableModule: new EnableModule(
      uow,
      registry,
      tenantModules,
      licences,
      new CodeModuleActivator(MODULE_ACTIVATORS)
    ),
    disableModule: new DisableModule(uow, registry, tenantModules, licences),
    setFeatureOverride: new SetFeatureOverride(uow, registry, tenantModules, licences),
  }
}

let instance: ReturnType<typeof build> | undefined

export const moduleServices = () => (instance ??= build())
