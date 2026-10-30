import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  ModuleManifest,
  RegistryModule,
  TenantModuleStatus,
} from '#platform/modules/domain/module'

export interface TenantModuleRow {
  moduleId: string
  status: TenantModuleStatus
  enabledAt: Date | null
  lastError: string | null
  configuration: Record<string, unknown>
}

export interface TenantFeatureRow {
  featureId: string
  override: boolean | null
  reason: string | null
  expiresAt: Date | null
}

/** Catálogo global (igual para todos os tenants). */
export interface RegistryStore {
  /** Grava o conjunto validado: cria/actualiza; o que saiu do código passa a DEPRECATED (nunca se apaga). */
  sync(
    manifests: readonly ModuleManifest[]
  ): Promise<{ created: number; updated: number; deprecated: number }>
  list(): Promise<RegistryModule[]>
}

export interface TenantModuleStore {
  /** Serializa as alterações de módulos do tenant (lock consultivo na transacção). */
  lock(scope: TenantScope): Promise<void>
  list(scope: TenantScope): Promise<TenantModuleRow[]>
  /** Cria ou actualiza (um único registo por módulo): repetir não duplica. */
  upsert(
    scope: TenantScope,
    moduleId: string,
    patch: { status: TenantModuleStatus; enabledAt?: Date | null; lastError?: string | null }
  ): Promise<void>
  listFeatures(scope: TenantScope): Promise<TenantFeatureRow[]>
  upsertFeature(
    scope: TenantScope,
    featureId: string,
    value: { override: boolean | null; reason: string | null; expiresAt: Date | null }
  ): Promise<void>
}

/**
 * Entrega do módulo ao tenant (sementes, configuração inicial): **código** do módulo, idempotente — repetir
 * depois de uma falha não duplica nada. Os módulos que precisem registam o seu activador.
 */
export interface ModuleActivator {
  activate(moduleCode: string, context: TenantContext): Promise<void>
}

export interface Licence {
  entitled: boolean
  modules: readonly string[]
  features: readonly string[]
}

/** Direitos comerciais do tenant (C02). */
export interface LicenceReader {
  forTenant(tenantId: string): Promise<Licence>
}

export interface Clock {
  now(): Date
}
